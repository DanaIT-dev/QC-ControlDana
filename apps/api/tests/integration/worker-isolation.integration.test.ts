import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Queue } from 'bullmq';
import { loadConfig } from '@sgr-registry/config';
import type { UserRole } from '@sgr-registry/contracts';
import {
  createOwnerPrismaClient,
  disconnectPrismaClient,
  upsertUserCredentials,
  type PrismaClient,
} from '@sgr-registry/database';
import {
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  SLA_EVALUATE_JOB,
  parseWorkerHeartbeat,
  resolveAttachmentQueueName,
  resolveMaintenanceQueueName,
  resolveNotificationQueueName,
  resolveWorkerHeartbeatKey,
  serializeWorkerHeartbeat,
  WORKER_HEARTBEAT_TTL_SECONDS,
  CONFIRMED_LAST_FIRST_TOKEN_ORDER,
  personNameWriteFields,
} from '@sgr-registry/domain';
import { NOTIFICATION_QUEUE } from '@sgr-registry/jobs';
import Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/configure-http';
import { hashArgon2id } from '../../src/auth/crypto';
import { startWorkerRuntime, type WorkerRuntime } from '../../../worker/src/runtime';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

let app: NestFastifyApplication;
let prisma: PrismaClient;
let redis: Redis;
const createdUserIds: string[] = [];
const createdActIds: string[] = [];

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
  cookies: Array<{ name: string; value: string }>;
}

async function inject(opts: {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  url: string;
  payload?: unknown;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
}): Promise<InjectResponse> {
  const instance = app.getHttpAdapter().getInstance();
  return instance.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload,
    cookies: opts.cookies,
    headers: {
      origin: loadConfig().WEB_ORIGIN,
      'x-request-id': `wrk-${Date.now()}-${Math.random()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(role: UserRole) {
  const email = `wrk.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: {
      ...personNameWriteFields(`Worker ${role}`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
      email,
      role,
      status: 'ACTIVE',
    },
  });
  await upsertUserCredentials(prisma, { userId: user.id, passwordHash });
  createdUserIds.push(user.id);
  return user;
}

async function login(email: string) {
  const response = await inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: DEMO_PASSWORD },
  });
  const body = response.json() as { csrfToken: string; id: string };
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value ?? '';
  return { body, cookie };
}

async function mutate(
  session: { cookie: string; body: { csrfToken: string } },
  opts: {
    method: 'POST' | 'PATCH' | 'PUT';
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  },
) {
  return inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload ?? {},
    cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    headers: { [CSRF_HEADER_NAME]: session.body.csrfToken, ...opts.headers },
  });
}

async function catalogs() {
  const suffix = Math.random().toString(16).slice(2, 8);
  const object = await prisma.propertyObject.create({
    data: { name: `Объект ${suffix}`, address: 'Минск' },
  });
  const customer = await prisma.organization.create({
    data: {
      officialName: `Заказчик ${suffix}`,
      postalAddress: 'addr',
      email: `cust-w-${suffix}@example.sgr.local`,
      phone: '1',
      contactPerson: 'К',
      roles: { create: [{ role: 'CUSTOMER' }] },
    },
  });
  const liable = await prisma.organization.create({
    data: {
      officialName: `Подрядчик ${suffix}`,
      postalAddress: 'addr',
      email: `liable-w-${suffix}@example.sgr.local`,
      phone: '1',
      contactPerson: 'П',
      roles: { create: [{ role: 'LIABLE_CONTRACTOR' }] },
    },
  });
  const defectType = await prisma.defectType.create({
    data: { code: `WRK-${suffix}`, name: `Дефект ${suffix}`, sortOrder: 50 },
  });
  return { object, customer, liable, defectType };
}

async function createActWithDefect(
  admin: { cookie: string; body: { csrfToken: string } },
  refs: Awaited<ReturnType<typeof catalogs>>,
  responsibleId: string,
) {
  await prisma.propertyObjectEngineer.createMany({
    data: [{ propertyObjectId: refs.object.id, userId: responsibleId }],
    skipDuplicates: true,
  });
  const response = await mutate(admin, {
    method: 'POST',
    url: '/api/acts',
    payload: {
      formCode: 'S1',
      objectId: refs.object.id,
      customerOrganizationId: refs.customer.id,
      issuedOn: '2026-08-20',
      defectItems: [
        {
          location: 'Помещение worker',
          defectTypeId: refs.defectType.id,
          claimDetails: 'Описание',
          liableOrganizationIds: [refs.liable.id],
          responsibleEngineerIds: [responsibleId],
          plannedDeadline: '2026-09-15',
        },
      ],
    },
    headers: { 'idempotency-key': `wrk-${Date.now()}-${Math.random()}` },
  });
  if (response.statusCode !== 201) {
    throw new Error(`createAct failed ${response.statusCode} ${JSON.stringify(response.json())}`);
  }
  const body = response.json() as { id: string };
  createdActIds.push(body.id);
  const started = await mutate(admin, {
    method: 'POST',
    url: `/api/acts/${body.id}/start`,
    payload: {},
  });
  if (started.statusCode !== 200) {
    throw new Error(`startAct failed ${started.statusCode} ${JSON.stringify(started.json())}`);
  }
  const defect = await prisma.defectItem.findFirstOrThrow({ where: { actId: body.id } });
  return { actId: body.id, defectItemId: defect.id };
}

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs = 45_000,
  diagnose?: () => Promise<string>,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const extra = diagnose ? await diagnose() : '';
  throw new Error(`timed out waiting for worker condition${extra}`);
}

async function mailpitMessagesFor(email: string): Promise<unknown[]> {
  const config = loadConfig();
  const list = await fetch(`${config.MAILPIT_API_URL}/api/v1/messages?limit=200`);
  const body = (await list.json()) as {
    messages?: Array<{ To?: Array<{ Address?: string }> }>;
  };
  return (body.messages ?? []).filter((item) => (item.To ?? []).some((to) => to.Address === email));
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
    original(...args);
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

describe('notification worker isolation', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.REDIS_KEY_PREFIX = 'sgr-test';
    const config = loadConfig();
    prisma = createOwnerPrismaClient(config.MIGRATION_DATABASE_URL);
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ logger: false, trustProxy: false }),
      { logger: false },
    );
    await configureHttpApp(app, config);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await prisma.systemSettings.upsert({
      where: { id: 'default' },
      update: {},
      create: { id: 'default', deadlineWarningDays: 3 },
    });
  });

  beforeEach(async () => {
    const config = loadConfig();
    const notificationQueue = new Queue(resolveNotificationQueueName(), {
      connection: { url: config.REDIS_URL, maxRetriesPerRequest: null },
    });
    const attachmentQueue = new Queue(resolveAttachmentQueueName(), {
      connection: { url: config.REDIS_URL, maxRetriesPerRequest: null },
    });
    await notificationQueue.obliterate({ force: true }).catch(() => undefined);
    await attachmentQueue.obliterate({ force: true }).catch(() => undefined);
    await notificationQueue.close();
    await attachmentQueue.close();
    await prisma.outboxEvent.deleteMany({
      where: { status: { in: ['PENDING', 'FAILED', 'CLAIMED'] } },
    });
    const keys = await redis.keys('sgr-test:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  afterAll(async () => {
    if (createdActIds.length > 0) {
      await prisma.emailDelivery.deleteMany({
        where: { recipient: { event: { actId: { in: createdActIds } } } },
      });
      await prisma.notificationRecipient.deleteMany({
        where: { event: { actId: { in: createdActIds } } },
      });
      await prisma.notificationEvent.deleteMany({ where: { actId: { in: createdActIds } } });
      await prisma.slaClock.deleteMany({ where: { defectItem: { actId: { in: createdActIds } } } });
      await prisma.defectItemEngineer.deleteMany({
        where: { defectItem: { actId: { in: createdActIds } } },
      });
      await prisma.defectItemLiableOrganization.deleteMany({
        where: { defectItem: { actId: { in: createdActIds } } },
      });
      await prisma.defectItem.deleteMany({ where: { actId: { in: createdActIds } } });
      await prisma.act.deleteMany({ where: { id: { in: createdActIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.propertyObjectEngineer.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.notificationRecipient.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user
        .deleteMany({ where: { id: { in: createdUserIds } } })
        .catch(() => undefined);
    }
    await app.close();
    await redis.quit();
    await disconnectPrismaClient();
  });

  it('does not register notification or attachment processors in the API', () => {
    const names: string[] = [];
    for (const moduleRef of app.get(ModulesContainer).values()) {
      for (const wrapper of moduleRef.providers.values()) {
        if (wrapper.metatype?.name) {
          names.push(wrapper.metatype.name);
        }
      }
    }
    expect(names).not.toContain('NotificationProcessor');
    expect(names).not.toContain('AttachmentScanProcessor');
    expect(names).not.toContain('NotificationDispatcher');
    expect(names).toContain('OutboxWriter');
  });

  it('keeps isolated queue names and heartbeat keys in test', () => {
    expect(resolveNotificationQueueName()).toBe('sgr-notifications-test');
    expect(resolveAttachmentQueueName()).toBe('sgr-attachments-test');
    expect(resolveMaintenanceQueueName()).toBe('sgr-maintenance-test');
    expect(resolveWorkerHeartbeatKey()).toBe('sgr:worker:heartbeat:test');
    expect(NOTIFICATION_QUEUE).toBe('sgr-notifications-test');
  });

  it('API-only leaves outbox PENDING, does not claim, and does not send mail', async () => {
    const adminUser = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await login(adminUser.email);
    const refs = await catalogs();
    const created = await createActWithDefect(admin, refs, responsible.id);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const ours = (
      await prisma.outboxEvent.findMany({ where: { type: 'RESPONSIBLE_ASSIGNED' } })
    ).filter(
      (row) => (row.payload as { defectItemId?: string }).defectItemId === created.defectItemId,
    );
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.every((row) => row.status === 'PENDING')).toBe(true);
    expect(await mailpitMessagesFor(responsible.email)).toHaveLength(0);
    const ready = await inject({ method: 'GET', url: '/api/ready' });
    expect(ready.statusCode).toBe(200);
  });

  it('starts the worker while API is up, processes one event and one email, heartbeat up', async () => {
    const adminUser = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await login(adminUser.email);
    const refs = await catalogs();
    const created = await createActWithDefect(admin, refs, responsible.id);
    const logs = captureLogs();
    let runtime: WorkerRuntime | undefined;
    try {
      runtime = await startWorkerRuntime({ listenHealth: false, scheduleOnStart: true });
      expect(logs.lines.some((line) => line.includes('Notification worker started'))).toBe(true);
      try {
        await waitUntil(async () => {
          const sent = await prisma.emailDelivery.count({
            where: { recipient: { userId: responsible.id }, status: 'SENT' },
          });
          return sent === 1;
        });
      } catch (error) {
        const deliveries = await prisma.emailDelivery.findMany({
          where: { recipient: { userId: responsible.id } },
          select: { status: true, lastErrorCode: true, attempts: true },
        });
        const outbox = (
          await prisma.outboxEvent.findMany({
            where: { type: 'RESPONSIBLE_ASSIGNED' },
            select: { status: true, lastErrorCode: true, payload: true },
          })
        ).filter(
          (row) => (row.payload as { defectItemId?: string }).defectItemId === created.defectItemId,
        );
        throw new Error(
          `${error instanceof Error ? error.message : 'timeout'} deliveries=${JSON.stringify(deliveries)} outbox=${JSON.stringify(outbox)}`,
          { cause: error },
        );
      }
      const heartbeat = parseWorkerHeartbeat(await redis.get(resolveWorkerHeartbeatKey()));
      expect(heartbeat.status).toBe('up');
      const raw = await redis.get(resolveWorkerHeartbeatKey());
      expect(raw).not.toMatch(/password|SMTP_|REDIS_URL|DATABASE_URL/i);
      expect(await mailpitMessagesFor(responsible.email)).toHaveLength(1);
      expect(
        await prisma.notificationEvent.count({
          where: { defectItemId: created.defectItemId, type: 'RESPONSIBLE_ASSIGNED' },
        }),
      ).toBe(1);
    } finally {
      logs.restore();
      const stoppedAt = Date.now();
      await runtime?.stop();
      expect(Date.now() - stoppedAt).toBeLessThan(8000);
    }
  });

  it('runs two workers without duplicating the event, email, or SLA evaluation', async () => {
    const adminUser = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await login(adminUser.email);
    const refs = await catalogs();
    const created = await createActWithDefect(admin, refs, responsible.id);
    let first: WorkerRuntime | undefined;
    let second: WorkerRuntime | undefined;
    const logs = captureLogs();
    const queue = new Queue(resolveNotificationQueueName(), {
      connection: { url: loadConfig().REDIS_URL, maxRetriesPerRequest: null },
    });
    const slaStarted = new Date();
    try {
      first = await startWorkerRuntime({ listenHealth: false, scheduleOnStart: false });
      second = await startWorkerRuntime({ listenHealth: false, scheduleOnStart: false });
      expect(
        logs.lines.filter((line) => line.includes('Notification worker started')),
      ).toHaveLength(2);
      await waitUntil(
        async () => {
          const sent = await prisma.emailDelivery.count({
            where: {
              status: 'SENT',
              recipient: {
                userId: responsible.id,
                event: { defectItemId: created.defectItemId, type: 'RESPONSIBLE_ASSIGNED' },
              },
            },
          });
          return sent === 1;
        },
        45_000,
        async () => {
          const deliveries = await prisma.emailDelivery.findMany({
            where: { recipient: { userId: responsible.id } },
            select: { status: true, lastErrorCode: true },
          });
          const outbox = await prisma.outboxEvent.findMany({
            where: { type: 'RESPONSIBLE_ASSIGNED' },
            select: { status: true, lastErrorCode: true, payload: true },
          });
          const ours = outbox.filter(
            (row) =>
              (row.payload as { defectItemId?: string }).defectItemId === created.defectItemId,
          );
          return ` deliveries=${JSON.stringify(deliveries)} outbox=${JSON.stringify(ours.map((row) => ({ status: row.status, lastErrorCode: row.lastErrorCode })))}`;
        },
      );
      await queue.add(
        SLA_EVALUATE_JOB,
        { reason: 'two-worker' },
        { jobId: `sla-two-${randomUUID()}` },
      );
      await waitUntil(async () => {
        const slaAfter = await prisma.auditLog.count({
          where: { action: 'SLA_EVALUATION_COMPLETED', occurredAt: { gte: slaStarted } },
        });
        return slaAfter >= 1;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(
        await prisma.auditLog.count({
          where: { action: 'SLA_EVALUATION_COMPLETED', occurredAt: { gte: slaStarted } },
        }),
      ).toBe(1);
      expect(
        await prisma.notificationEvent.count({
          where: { defectItemId: created.defectItemId, type: 'RESPONSIBLE_ASSIGNED' },
        }),
      ).toBe(1);
      expect(await mailpitMessagesFor(responsible.email)).toHaveLength(1);
    } finally {
      logs.restore();
      await first?.stop();
      await second?.stop();
      await queue.close();
    }
  });

  it('recovers a backlog after the worker restarts without duplicate email', async () => {
    const adminUser = await createUser('ADMIN');
    const first = await createUser('RESPONSIBLE_ENGINEER');
    const second = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await login(adminUser.email);
    const refs = await catalogs();
    const firstAct = await createActWithDefect(admin, refs, first.id);
    const secondAct = await createActWithDefect(admin, refs, second.id);
    const oursPending = (
      await prisma.outboxEvent.findMany({ where: { type: 'RESPONSIBLE_ASSIGNED' } })
    ).filter((row) => {
      const defectItemId = (row.payload as { defectItemId?: string }).defectItemId;
      return defectItemId === firstAct.defectItemId || defectItemId === secondAct.defectItemId;
    });
    expect(oursPending.every((row) => row.status === 'PENDING')).toBe(true);
    expect(oursPending.length).toBeGreaterThanOrEqual(2);
    expect(await mailpitMessagesFor(first.email)).toHaveLength(0);
    let runtime: WorkerRuntime | undefined;
    try {
      runtime = await startWorkerRuntime({ listenHealth: false, scheduleOnStart: true });
      await waitUntil(async () => {
        const leftover = (
          await prisma.outboxEvent.findMany({ where: { type: 'RESPONSIBLE_ASSIGNED' } })
        ).filter((row) => {
          const defectItemId = (row.payload as { defectItemId?: string }).defectItemId;
          return (
            (defectItemId === firstAct.defectItemId || defectItemId === secondAct.defectItemId) &&
            (row.status === 'PENDING' || row.status === 'FAILED')
          );
        });
        const sentFirst = await prisma.emailDelivery.count({
          where: { recipient: { userId: first.id }, status: 'SENT' },
        });
        const sentSecond = await prisma.emailDelivery.count({
          where: { recipient: { userId: second.id }, status: 'SENT' },
        });
        return leftover.length === 0 && sentFirst === 1 && sentSecond === 1;
      }, 30_000);
      expect(await mailpitMessagesFor(first.email)).toHaveLength(1);
      expect(await mailpitMessagesFor(second.email)).toHaveLength(1);
    } finally {
      await runtime?.stop();
    }
  });

  it('expires heartbeat after TTL and leaves /api/ready independent of worker', async () => {
    const key = resolveWorkerHeartbeatKey();
    await redis.set(
      key,
      serializeWorkerHeartbeat({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      'EX',
      2,
    );
    expect(parseWorkerHeartbeat(await redis.get(key)).status).toBe('up');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(parseWorkerHeartbeat(await redis.get(key))).toEqual({ status: 'down', ageMs: null });
    expect(WORKER_HEARTBEAT_TTL_SECONDS).toBe(15);
    const ready = await inject({ method: 'GET', url: '/api/ready' });
    expect(ready.statusCode).toBe(200);
    const health = await inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  });
});
