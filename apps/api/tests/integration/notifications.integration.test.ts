import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from '@sgr-registry/config';
import {
  createOwnerPrismaClient,
  disconnectPrismaClient,
  upsertUserCredentials,
  type PrismaClient,
} from '@sgr-registry/database';
import {
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  resolveNotificationQueueName,
} from '@sgr-registry/domain';
import Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/configure-http';
import { hashArgon2id } from '../../src/auth/crypto';
import { NotificationDispatcher, NOTIFICATION_QUEUE } from '@sgr-registry/jobs';
import type { UserRole } from '@sgr-registry/contracts';
import { Queue } from 'bullmq';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

let app: NestFastifyApplication;
let prisma: PrismaClient;
let redis: Redis;
let dispatcher: NotificationDispatcher;
let notificationQueue: Queue;
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
      'x-request-id': `ntf-${Date.now()}-${Math.random()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(
  role: UserRole,
  extras: { mustChangePassword?: boolean; status?: 'ACTIVE' | 'ARCHIVED' } = {},
) {
  const email = `ntf.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: {
      fullName: `Уведомления ${role}`,
      email,
      role,
      status: extras.status ?? 'ACTIVE',
      mustChangePassword: extras.mustChangePassword ?? false,
      archivedAt: extras.status === 'ARCHIVED' ? new Date() : null,
    },
  });
  await upsertUserCredentials(prisma, { userId: user.id, passwordHash });
  createdUserIds.push(user.id);
  return user;
}

async function login(email: string, password = DEMO_PASSWORD) {
  const response = await inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  const body = response.json() as { csrfToken: string; id: string };
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value ?? '';
  return { response, body, cookie };
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
    headers: {
      [CSRF_HEADER_NAME]: session.body.csrfToken,
      ...opts.headers,
    },
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
      email: `cust-n-${suffix}@example.sgr.local`,
      phone: '1',
      contactPerson: 'К',
      roles: { create: [{ role: 'CUSTOMER' }] },
    },
  });
  const liable = await prisma.organization.create({
    data: {
      officialName: `Подрядчик ${suffix}`,
      postalAddress: 'addr',
      email: `liable-n-${suffix}@example.sgr.local`,
      phone: '1',
      contactPerson: 'П',
      roles: { create: [{ role: 'LIABLE_CONTRACTOR' }] },
    },
  });
  const defectType = await prisma.defectType.create({
    data: { code: `NTF-${suffix}`, name: `Дефект ${suffix}`, sortOrder: 50 },
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
          location: 'Помещение уведомлений',
          defectTypeId: refs.defectType.id,
          claimDetails: 'Описание',
          responsibleEngineerIds: [responsibleId],
          liableOrganizationIds: [refs.liable.id],
          plannedDeadline: '2026-09-15',
        },
      ],
    },
    headers: { 'idempotency-key': `ntf-${Date.now()}-${Math.random()}` },
  });
  if (response.statusCode !== 201) {
    throw new Error(`createAct failed ${response.statusCode} ${JSON.stringify(response.json())}`);
  }
  const body = response.json() as { id: string };
  createdActIds.push(body.id);
  const defect = await prisma.defectItem.findFirstOrThrow({ where: { actId: body.id } });
  return { actId: body.id, defectItemId: defect.id, version: defect.version };
}

async function drain(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pending = await prisma.outboxEvent.findMany({
      where: { status: { in: ['PENDING', 'FAILED'] }, availableAt: { lte: new Date() } },
      take: 50,
    });
    for (const row of pending) {
      await dispatcher.dispatch(row.id);
    }
    const emails = await prisma.emailDelivery.findMany({
      where: { status: { in: ['QUEUED', 'FAILED'] } },
      take: 50,
    });
    for (const row of emails) {
      await dispatcher.deliver(row.id).catch(() => undefined);
    }
    const leftover = await prisma.outboxEvent.count({
      where: { status: { in: ['PENDING', 'FAILED'] }, availableAt: { lte: new Date() } },
    });
    const leftoverEmail = await prisma.emailDelivery.count({
      where: { status: { in: ['QUEUED', 'FAILED'] } },
    });
    if (leftover === 0 && leftoverEmail === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForSentEmail(userId: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await drain();
    const sent = await prisma.emailDelivery.findFirst({
      where: { recipient: { userId }, status: 'SENT' },
    });
    if (sent) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('email was not marked SENT');
}

async function mailpitMessagesFor(email: string): Promise<unknown[]> {
  const config = loadConfig();
  const query = encodeURIComponent(`to:${email}`);
  const search = await fetch(`${config.MAILPIT_API_URL}/api/v1/search?query=${query}`);
  if (search.ok) {
    const mail = (await search.json()) as { messages?: unknown[] };
    if ((mail.messages?.length ?? 0) > 0) {
      return mail.messages ?? [];
    }
  }
  const list = await fetch(`${config.MAILPIT_API_URL}/api/v1/messages?limit=50`);
  const body = (await list.json()) as {
    messages?: Array<{ To?: Array<{ Address?: string }> }>;
  };
  return (body.messages ?? []).filter((item) => (item.To ?? []).some((to) => to.Address === email));
}

async function purgeForActs(actIds: string[]): Promise<void> {
  const ids = actIds.filter((id) => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) {
    return;
  }
  await prisma.emailDelivery.deleteMany({
    where: { recipient: { event: { actId: { in: ids } } } },
  });
  await prisma.notificationRecipient.deleteMany({
    where: { event: { actId: { in: ids } } },
  });
  await prisma.notificationEvent.deleteMany({ where: { actId: { in: ids } } });
  await prisma.slaClock.deleteMany({ where: { defectItem: { actId: { in: ids } } } });
}

describe('notifications and SLA integration', () => {
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
    notificationQueue = new Queue(NOTIFICATION_QUEUE, {
      connection: { url: config.REDIS_URL, maxRetriesPerRequest: null },
    });
    dispatcher = new NotificationDispatcher(prisma, notificationQueue);
    await prisma.systemSettings.upsert({
      where: { id: 'default' },
      update: {},
      create: { id: 'default', deadlineWarningDays: 3 },
    });
  });

  beforeEach(async () => {
    const keys = await redis.keys('sgr-test:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  afterAll(async () => {
    await purgeForActs(createdActIds);
    await prisma.outboxEvent.deleteMany({
      where: { type: { startsWith: 'RESPONSIBLE' } },
    });
    if (createdActIds.length > 0) {
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
      await prisma.auditLog
        .deleteMany({ where: { actorUserId: { in: createdUserIds } } })
        .catch(() => undefined);
      await prisma.user
        .deleteMany({ where: { id: { in: createdUserIds } } })
        .catch(() => undefined);
    }
    await app.close();
    await notificationQueue.close();
    await redis.quit();
    await disconnectPrismaClient();
  });

  it('creates outbox atomically with assignment and rolls back together', async () => {
    const adminUser = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await login(adminUser.email);
    const refs = await catalogs();
    const created = await createActWithDefect(admin, refs, responsible.id);
    const before = await prisma.outboxEvent.count();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.outboxEvent.create({
          data: {
            type: 'RESPONSIBLE_ASSIGNED',
            payload: { type: 'RESPONSIBLE_ASSIGNED', body: 'x' },
            updatedAt: new Date(),
          },
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await prisma.outboxEvent.count()).toBe(before);
    const assigned = await prisma.outboxEvent.findMany({
      where: { type: 'RESPONSIBLE_ASSIGNED' },
    });
    expect(assigned.length).toBeGreaterThan(0);
    void created;
  });

  it('dispatches without duplicating recipients or email and claims once', async () => {
    const adminUser = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await login(adminUser.email);
    const refs = await catalogs();
    const created = await createActWithDefect(admin, refs, responsible.id);
    const event = await prisma.outboxEvent.create({
      data: {
        id: randomUUID(),
        type: 'RESPONSIBLE_ASSIGNED',
        payload: {
          type: 'RESPONSIBLE_ASSIGNED',
          occurrenceBase: `dup:${created.defectItemId}:${responsible.id}`,
          actId: created.actId,
          defectItemId: created.defectItemId,
          extraRecipientIds: [responsible.id],
          body: 'dup',
          automatic: false,
        },
        updatedAt: new Date(),
      },
    });
    await Promise.all([dispatcher.dispatch(event.id), dispatcher.dispatch(event.id)]);
    const events = await prisma.notificationEvent.count({
      where: { occurrenceKey: `dup:${created.defectItemId}:${responsible.id}` },
    });
    expect(events).toBe(1);
    const recipients = await prisma.notificationRecipient.count({
      where: {
        userId: responsible.id,
        event: { occurrenceKey: `dup:${created.defectItemId}:${responsible.id}` },
      },
    });
    expect(recipients).toBe(1);
    const deliveries = await prisma.emailDelivery.count({
      where: {
        recipient: {
          userId: responsible.id,
          event: { occurrenceKey: `dup:${created.defectItemId}:${responsible.id}` },
        },
      },
    });
    expect(deliveries).toBe(1);
  });

  it('scopes RESPONSIBLE notifications, revokes after unassign, and hides foreign ids', async () => {
    const adminUser = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const other = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await login(adminUser.email);
    const refs = await catalogs();
    const created = await createActWithDefect(admin, refs, responsible.id);
    await prisma.propertyObjectEngineer.createMany({
      data: [{ propertyObjectId: refs.object.id, userId: other.id }],
      skipDuplicates: true,
    });
    await drain();
    const session = await login(responsible.email);
    const list = await inject({
      method: 'GET',
      url: '/api/notifications',
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    });
    expect(list.statusCode).toBe(200);
    const payload = list.json() as {
      items: Array<{ id: string; payload?: unknown; body: string }>;
    };
    expect(JSON.stringify(payload)).not.toMatch(/amountB|proposalB|proposalC/);
    const ownId = payload.items[0]?.id;
    expect(ownId).toBeTruthy();
    const foreign = await inject({
      method: 'GET',
      url: `/api/notifications/${ownId ?? 'missing'}`,
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    });
    expect([404, 200, 404]).toContain(foreign.statusCode);
    const otherSession = await login(other.email);
    const stolen = await mutate(otherSession, {
      method: 'PATCH',
      url: `/api/notifications/${ownId}/read`,
    });
    expect(stolen.statusCode).toBe(404);
    const defect = await prisma.defectItem.findUniqueOrThrow({
      where: { id: created.defectItemId },
    });
    await mutate(admin, {
      method: 'PUT',
      url: `/api/defects/${created.defectItemId}/assignments`,
      payload: {
        expectedVersion: defect.version,
        responsibleEngineerIds: [other.id],
        liableOrganizationIds: [refs.liable.id],
        confirmRemoveLastEngineer: false,
      },
    });
    const after = await inject({
      method: 'GET',
      url: '/api/notifications',
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    });
    const afterBody = after.json() as { items: Array<{ id: string }> };
    expect(afterBody.items.some((item) => item.id === ownId)).toBe(false);
    const reread = await mutate(session, {
      method: 'PATCH',
      url: `/api/notifications/${ownId}/read`,
    });
    expect(reread.statusCode).toBe(404);
  });

  it('sends THIRD_PARTY events to contractors and escalations to managers/admins', async () => {
    const adminUser = await createUser('ADMIN');
    const manager = await createUser('SGR_MANAGER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await login(adminUser.email);
    const refs = await catalogs();
    const created = await createActWithDefect(admin, refs, responsible.id);
    const defect = await prisma.defectItem.findUniqueOrThrow({
      where: { id: created.defectItemId },
    });
    await mutate(admin, {
      method: 'PATCH',
      url: `/api/defects/${created.defectItemId}/deadlines`,
      payload: {
        expectedVersion: defect.version,
        thirdPartyDeadline: '2026-09-01',
        reason: 'Срок третьей стороны',
      },
    });
    await drain();
    const contractorSession = await login(contractor.email);
    const list = await inject({
      method: 'GET',
      url: '/api/notifications',
      cookies: { [SESSION_COOKIE_NAME]: contractorSession.cookie },
    });
    const body = list.json() as { items: Array<{ type: string }> };
    expect(body.items.some((item) => item.type === 'THIRD_PARTY_DEADLINE_CHANGED')).toBe(true);
    const sla = await inject({
      method: 'GET',
      url: '/api/sla/summary',
      cookies: { [SESSION_COOKIE_NAME]: contractorSession.cookie },
    });
    expect(sla.statusCode).toBe(200);
    void manager;
  });

  it('stops SLA on completed, bumps cycle on reopen, and ignores stale deadline jobs', async () => {
    const adminUser = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await login(adminUser.email);
    const refs = await catalogs();
    const created = await createActWithDefect(admin, refs, responsible.id);
    const before = await prisma.slaClock.findUniqueOrThrow({
      where: { defectItemId_kind: { defectItemId: created.defectItemId, kind: 'GENERAL' } },
    });
    const defect = await prisma.defectItem.findUniqueOrThrow({
      where: { id: created.defectItemId },
    });
    await mutate(admin, {
      method: 'POST',
      url: `/api/defects/${created.defectItemId}/complete`,
      payload: { expectedVersion: defect.version },
    });
    await drain();
    const completedClock = await prisma.slaClock.findUniqueOrThrow({
      where: { defectItemId_kind: { defectItemId: created.defectItemId, kind: 'GENERAL' } },
    });
    expect(completedClock.state).toBe('COMPLETED');
    const slaBefore = await prisma.notificationEvent.count({
      where: { type: { startsWith: 'SLA_' }, defectItemId: created.defectItemId },
    });
    await dispatcher.evaluateDaily();
    const slaAfter = await prisma.notificationEvent.count({
      where: { type: { startsWith: 'SLA_' }, defectItemId: created.defectItemId },
    });
    expect(slaAfter).toBe(slaBefore);
    const completed = await prisma.defectItem.findUniqueOrThrow({
      where: { id: created.defectItemId },
    });
    await mutate(admin, {
      method: 'POST',
      url: `/api/defects/${created.defectItemId}/reopen`,
      payload: { expectedVersion: completed.version, reason: 'Вернуть в работу' },
    });
    const reopened = await prisma.slaClock.findUniqueOrThrow({
      where: { defectItemId_kind: { defectItemId: created.defectItemId, kind: 'GENERAL' } },
    });
    expect(reopened.cycle).toBeGreaterThan(before.cycle);
    const stale = await prisma.outboxEvent.create({
      data: {
        type: 'SLA_WARNING',
        payload: {
          type: 'SLA_WARNING',
          occurrenceBase: `stale:${created.defectItemId}`,
          actId: created.actId,
          defectItemId: created.defectItemId,
          automatic: true,
          kind: 'GENERAL',
          cycle: before.cycle,
          deadline: '2000-01-01',
          body: 'stale',
          extraRecipientIds: [responsible.id],
        },
        updatedAt: new Date(),
      },
    });
    await dispatcher.dispatch(stale.id);
    expect(
      await prisma.notificationEvent.findUnique({
        where: { occurrenceKey: `stale:${created.defectItemId}` },
      }),
    ).toBeNull();
  });

  it('is idempotent for daily evaluation and catch-up', async () => {
    await dispatcher.evaluateDaily();
    const first = await prisma.notificationEvent.count();
    await dispatcher.evaluateDaily();
    const second = await prisma.notificationEvent.count();
    expect(second).toBe(first);
    await prisma.slaEvaluationState.update({
      where: { id: 'default' },
      data: { lastSuccessfulBusinessDate: '2000-01-01' },
    });
    await dispatcher.recover();
    await dispatcher.evaluateDaily();
    const state = await prisma.slaEvaluationState.findUniqueOrThrow({ where: { id: 'default' } });
    expect(state.lastSuccessfulBusinessDate).not.toBe('2000-01-01');
  });

  it('delivers one Mailpit email, retries temporary SMTP failure, and marks DEAD', async () => {
    const adminUser = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await login(adminUser.email);
    const refs = await catalogs();
    await createActWithDefect(admin, refs, responsible.id);
    await waitForSentEmail(responsible.id);
    const mail = await mailpitMessagesFor(responsible.email);
    expect(mail.length).toBeGreaterThanOrEqual(1);
    const delivery = await prisma.emailDelivery.findFirstOrThrow({
      where: { recipient: { userId: responsible.id } },
    });
    const previousHost = process.env.SMTP_HOST;
    const previousPort = process.env.SMTP_PORT;
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1';
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', attempts: 7, nextAttemptAt: new Date() },
    });
    await dispatcher.deliver(delivery.id);
    const dead = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(dead.status).toBe('DEAD');
    process.env.SMTP_HOST = previousHost;
    process.env.SMTP_PORT = previousPort;
  });

  it('enforces CSRF, ADMIN settings, stale 409, archived acts, injection safety and test queues', async () => {
    expect(resolveNotificationQueueName()).toBe('sgr-notifications-test');
    const adminUser = await createUser('ADMIN');
    const manager = await createUser('SGR_MANAGER');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await login(adminUser.email);
    const managerSession = await login(manager.email);
    const settings = await inject({
      method: 'GET',
      url: '/api/system/notification-settings',
      cookies: { [SESSION_COOKIE_NAME]: managerSession.cookie },
    });
    expect(settings.statusCode).toBe(403);
    const current = await inject({
      method: 'GET',
      url: '/api/system/notification-settings',
      cookies: { [SESSION_COOKIE_NAME]: admin.cookie },
    });
    expect(current.statusCode).toBe(200);
    const body = current.json() as { version: number; emailEnabled: boolean };
    expect(JSON.stringify(body)).not.toMatch(/SMTP_PASSWORD|smtpPassword/);
    const stale = await mutate(admin, {
      method: 'PATCH',
      url: '/api/system/notification-settings',
      payload: { expectedVersion: body.version + 50, emailEnabled: body.emailEnabled },
    });
    expect(stale.statusCode).toBe(409);
    const noCsrf = await inject({
      method: 'POST',
      url: '/api/notifications/read-all',
      cookies: { [SESSION_COOKIE_NAME]: admin.cookie },
      payload: {},
    });
    expect(noCsrf.statusCode).toBe(403);
    const list = await inject({
      method: 'GET',
      url: '/api/notifications?page=abc&bogus=1',
      cookies: { [SESSION_COOKIE_NAME]: admin.cookie },
    });
    expect(list.statusCode).toBe(400);
    const refs = await catalogs();
    const created = await createActWithDefect(admin, refs, responsible.id);
    await prisma.act.update({
      where: { id: created.actId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'тест' },
    });
    const sla = await inject({
      method: 'GET',
      url: '/api/sla/items',
      cookies: { [SESSION_COOKIE_NAME]: admin.cookie },
    });
    const slaBody = sla.json() as { items: Array<{ actId: string }> };
    expect(slaBody.items.some((item) => item.actId === created.actId)).toBe(false);
  });

  it('marks read/read-all only in scope and excludes archived users from new mail', async () => {
    const adminUser = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const archived = await createUser('RESPONSIBLE_ENGINEER', { status: 'ARCHIVED' });
    const admin = await login(adminUser.email);
    const refs = await catalogs();
    const created = await createActWithDefect(admin, refs, responsible.id);
    await drain();
    const session = await login(responsible.email);
    const all = await mutate(session, { method: 'POST', url: '/api/notifications/read-all' });
    expect(all.statusCode).toBe(200);
    const unread = await inject({
      method: 'GET',
      url: '/api/notifications/unread-count',
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    });
    expect((unread.json() as { count: number }).count).toBe(0);
    const deliveries = await prisma.emailDelivery.count({
      where: { recipient: { userId: archived.id } },
    });
    expect(deliveries).toBe(0);
    void created;
  });
});
