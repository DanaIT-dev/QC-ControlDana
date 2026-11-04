import 'reflect-metadata';
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
  CONFIRMED_LAST_FIRST_TOKEN_ORDER,
  personNameWriteFields,
} from '@sgr-registry/domain';
import Redis from 'ioredis';
import { NotificationDispatcher } from '@sgr-registry/jobs';
import type { UserRole } from '@sgr-registry/contracts';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/configure-http';
import { hashArgon2id } from '../../src/auth/crypto';

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
      'x-request-id': `closure-${Date.now()}-${Math.random()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(role: UserRole) {
  const email = `closure.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: {
      ...personNameWriteFields(`Согласование ${role}`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
      email,
      role,
      status: 'ACTIVE',
      mustChangePassword: false,
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
  const body = response.json() as { csrfToken: string };
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value ?? '';
  return { cookie, body };
}

type Session = Awaited<ReturnType<typeof login>>;

async function mutate(
  session: Session,
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
    payload: opts.payload,
    cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    headers: { [CSRF_HEADER_NAME]: session.body.csrfToken, ...opts.headers },
  });
}

async function read(session: Session, url: string) {
  return inject({
    method: 'GET',
    url,
    cookies: { [SESSION_COOKIE_NAME]: session.cookie },
  });
}

async function catalogs() {
  const suffix = Math.random().toString(16).slice(2, 8);
  const object = await prisma.propertyObject.create({
    data: { name: `Объект согласования ${suffix}`, address: 'Минск' },
  });
  const customer = await prisma.organization.create({
    data: {
      officialName: `Заказчик согласования ${suffix}`,
      postalAddress: 'addr',
      email: `closure-cust-${suffix}@example.sgr.local`,
      phone: '1',
      contactPerson: 'К',
      roles: { create: [{ role: 'CUSTOMER' }] },
    },
  });
  const liable = await prisma.organization.create({
    data: {
      officialName: `Подрядчик согласования ${suffix}`,
      postalAddress: 'addr',
      email: `closure-liable-${suffix}@example.sgr.local`,
      phone: '1',
      contactPerson: 'П',
      roles: { create: [{ role: 'LIABLE_CONTRACTOR' }] },
    },
  });
  const defectType = await prisma.defectType.create({
    data: { code: `CLS-${suffix}`, name: `Дефект ${suffix}`, sortOrder: 50 },
  });
  return { object, customer, liable, defectType };
}

async function assign(objectId: string, userIds: string[]) {
  for (const userId of userIds) {
    await prisma.propertyObjectEngineer.upsert({
      where: { propertyObjectId_userId: { propertyObjectId: objectId, userId } },
      create: { propertyObjectId: objectId, userId },
      update: { unassignedAt: null, revokedByUserId: null },
    });
  }
}

async function unassign(objectId: string, userIds: string[]) {
  await prisma.propertyObjectEngineer.updateMany({
    where: { propertyObjectId: objectId, userId: { in: userIds }, unassignedAt: null },
    data: { unassignedAt: new Date() },
  });
}

async function startedAct(session: Session, engineerIds: string[]) {
  const catalog = await catalogs();
  await assign(catalog.object.id, engineerIds);
  const created = await mutate(session, {
    method: 'POST',
    url: '/api/acts',
    payload: {
      formCode: 'S1',
      objectId: catalog.object.id,
      customerOrganizationId: catalog.customer.id,
      issuedOn: '2026-11-04',
      defectItems: [
        {
          location: 'Кухня',
          defectTypeId: catalog.defectType.id,
          claimDetails: 'Трещина',
          plannedDeadline: '2026-12-01',
          responsibleEngineerIds: engineerIds.slice(0, 1),
          liableOrganizationIds: [catalog.liable.id],
        },
      ],
    },
    headers: { 'idempotency-key': `closure-${Date.now()}-${Math.random().toString(16).slice(2)}` },
  });
  expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
  const actId = (created.json() as { id: string }).id;
  createdActIds.push(actId);
  expect(
    (await mutate(session, { method: 'POST', url: `/api/acts/${actId}/start`, payload: {} }))
      .statusCode,
  ).toBe(200);
  return catalog;
}

function detailOf(response: InjectResponse) {
  return response.json() as {
    version: number;
    status: string;
    objectName: string | null;
    closureMethod: string | null;
    defectFingerprint: string;
    canDirectCloseWithoutInspection: boolean;
    canRequestClosureWithoutInspection: boolean;
    viewerMayMutateAct: boolean;
    closureRequest: {
      id: string;
      status: string;
      canDecide: boolean;
      reason: string;
      requestedByName: string;
      decidedByName: string | null;
    } | null;
    defectItems: Array<{
      id: string;
      version: number;
      status: string;
      deadlineControlActive: boolean;
    }>;
  };
}

async function dispatchAct(actId: string) {
  const rows = await prisma.outboxEvent.findMany({
    where: { payload: { path: ['actId'], equals: actId } },
  });
  const dispatcher = new NotificationDispatcher(prisma, { add: async () => undefined } as never);
  for (const row of rows) {
    if (row.status === 'PENDING') {
      await dispatcher.dispatch(row.id);
    }
  }
}

describe('act closure approval', () => {
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
  });

  beforeEach(async () => {
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
      await prisma.analyticsInsightDefect.deleteMany({
        where: { defectItem: { actId: { in: createdActIds } } },
      });
      await prisma.defectInspectionAttempt.deleteMany({
        where: { defectItem: { actId: { in: createdActIds } } },
      });
      await prisma.actClosureRequest.deleteMany({ where: { actId: { in: createdActIds } } });
      await prisma.defectItemLiableOrganization.deleteMany({
        where: { defectItem: { actId: { in: createdActIds } } },
      });
      await prisma.defectItemEngineer.deleteMany({
        where: { defectItem: { actId: { in: createdActIds } } },
      });
      await prisma.act.updateMany({
        where: { id: { in: createdActIds } },
        data: {
          closureMethod: null,
          closedWithoutInspectionAt: null,
          closedWithoutInspectionByUserId: null,
          closedWithoutInspectionByName: null,
          closureReason: null,
        },
      });
      await prisma.defectItem.updateMany({
        where: { actId: { in: createdActIds } },
        data: { closureMethod: null },
      });
      await prisma.defectItem.deleteMany({ where: { actId: { in: createdActIds } } });
      await prisma.act.deleteMany({ where: { id: { in: createdActIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.propertyObjectEngineer.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.idempotencyRecord.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
      await prisma.auditLog
        .deleteMany({ where: { actorUserId: { in: createdUserIds } } })
        .catch(() => undefined);
      await prisma.user
        .deleteMany({ where: { id: { in: createdUserIds } } })
        .catch(() => undefined);
    }
    await app.close();
    await redis.quit();
    await disconnectPrismaClient();
  });

  it('lets an assigned engineer close directly and keeps ordinary inspection', async () => {
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await createUser('ADMIN');
    const session = await login(engineer.email);
    const adminSession = await login(admin.email);
    await startedAct(session, [engineer.id]);
    const detail = detailOf(await read(session, `/api/acts/${createdActIds.at(-1)}`));
    const actId = createdActIds.at(-1)!;
    expect(detail.canDirectCloseWithoutInspection).toBe(true);
    expect(detail.canRequestClosureWithoutInspection).toBe(false);
    const submitted = await mutate(session, {
      method: 'POST',
      url: `/api/defects/${detail.defectItems[0]!.id}/submit-for-inspection`,
      payload: { expectedVersion: detail.defectItems[0]!.version, comment: 'Готово' },
    });
    expect(submitted.statusCode).toBe(200);
    const waiting = detailOf(await read(session, `/api/acts/${actId}`));
    expect(waiting.status).toBe('IN_PROGRESS');
    expect(waiting.defectItems[0]?.status).toBe('PENDING_INSPECTION');
    expect(waiting.canDirectCloseWithoutInspection).toBe(true);
    const returned = await mutate(adminSession, {
      method: 'POST',
      url: `/api/defects/${detail.defectItems[0]!.id}/reject-repair`,
      payload: { expectedVersion: detail.defectItems[0]!.version + 1, reason: 'Нужна доработка' },
    });
    expect(returned.statusCode).toBe(200);
    const again = detailOf(await read(session, `/api/acts/${actId}`));
    expect(
      (
        await mutate(session, {
          method: 'POST',
          url: `/api/defects/${again.defectItems[0]!.id}/submit-for-inspection`,
          payload: { expectedVersion: again.defectItems[0]!.version, comment: 'Повторно готово' },
        })
      ).statusCode,
    ).toBe(200);
    const pending = detailOf(await read(adminSession, `/api/acts/${actId}`));
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: `/api/defects/${pending.defectItems[0]!.id}/accept-repair`,
          payload: { expectedVersion: pending.defectItems[0]!.version },
        })
      ).statusCode,
    ).toBe(200);
    const accepted = await prisma.defectItem.findUniqueOrThrow({
      where: { id: pending.defectItems[0]!.id },
    });
    expect(accepted.acceptedAt).not.toBeNull();
    expect(accepted.closureMethod).toBeNull();
    const directCatalog = await startedAct(session, [engineer.id]);
    const directId = createdActIds.at(-1)!;
    const direct = detailOf(await read(session, `/api/acts/${directId}`));
    expect(direct.canDirectCloseWithoutInspection).toBe(true);
    expect(direct.canRequestClosureWithoutInspection).toBe(false);
    expect(
      (
        await mutate(session, {
          method: 'POST',
          url: `/api/acts/${directId}/close-without-inspection`,
          payload: { expectedVersion: direct.version, reason: 'Свой объект' },
        })
      ).statusCode,
    ).toBe(200);
    const closed = await prisma.act.findUniqueOrThrow({ where: { id: directId } });
    expect(closed.closureMethod).toBe('WITHOUT_INSPECTION');
    expect(closed.closedWithoutInspectionByUserId).toBe(engineer.id);
    expect(await prisma.actClosureRequest.count({ where: { actId: directId } })).toBe(0);
    expect(directCatalog.object.name).toContain('Объект согласования');
  });

  it('requires approval when the engineer is not assigned and hides a foreign act', async () => {
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const stranger = await createUser('RESPONSIBLE_ENGINEER');
    const approver = await createUser('RESPONSIBLE_ENGINEER');
    const manager = await createUser('MANAGER');
    const admin = await createUser('ADMIN');
    const session = await login(engineer.email);
    const strangerSession = await login(stranger.email);
    const approverSession = await login(approver.email);
    const managerSession = await login(manager.email);
    const adminSession = await login(admin.email);
    const catalog = await startedAct(session, [engineer.id, approver.id]);
    const actId = createdActIds.at(-1)!;
    await unassign(catalog.object.id, [engineer.id]);
    const visible = detailOf(await read(session, `/api/acts/${actId}`));
    expect(visible.viewerMayMutateAct).toBe(false);
    expect(visible.objectName).toBe(catalog.object.name);
    expect(visible.canDirectCloseWithoutInspection).toBe(false);
    expect(visible.canRequestClosureWithoutInspection).toBe(true);
    expect(visible.defectItems[0]!.deadlineControlActive).toBe(true);
    expect(
      (
        await mutate(session, {
          method: 'POST',
          url: `/api/acts/${actId}/close-without-inspection`,
          payload: { expectedVersion: visible.version, reason: 'Прямой обход' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await read(strangerSession, `/api/acts/${actId}`)).statusCode).toBe(404);
    expect(
      (
        await mutate(strangerSession, {
          method: 'POST',
          url: `/api/acts/${actId}/close-without-inspection/requests`,
          payload: { reason: 'Чужой акт' },
        })
      ).statusCode,
    ).toBe(404);
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(
      (
        await mutate(session, {
          method: 'POST',
          url: `/api/acts/${missing}/close-without-inspection/requests`,
          payload: { reason: 'Нет такого акта' },
        })
      ).statusCode,
    ).toBe(404);
    const requested = await mutate(session, {
      method: 'POST',
      url: `/api/acts/${actId}/close-without-inspection/requests`,
      payload: { reason: 'Объект уже не мой' },
    });
    expect(requested.statusCode).toBe(200);
    const repeated = await mutate(session, {
      method: 'POST',
      url: `/api/acts/${actId}/close-without-inspection/requests`,
      payload: { reason: 'Объект уже не мой' },
    });
    expect(repeated.statusCode).toBe(200);
    expect((repeated.json() as { idempotent: boolean }).idempotent).toBe(true);
    expect(
      (
        await mutate(session, {
          method: 'POST',
          url: `/api/acts/${actId}/close-without-inspection/requests`,
          payload: { reason: 'Другая причина' },
        })
      ).statusCode,
    ).toBe(409);
    const pendingAct = await prisma.act.findUniqueOrThrow({ where: { id: actId } });
    expect(pendingAct.status).toBe('IN_PROGRESS');
    const clocks = await prisma.slaClock.findMany({
      where: { defectItem: { actId } },
    });
    expect(clocks.every((clock) => clock.state !== 'COMPLETED')).toBe(true);
    await dispatchAct(actId);
    const managerNotices = await prisma.notificationRecipient.count({
      where: { userId: manager.id, event: { actId } },
    });
    expect(managerNotices).toBe(0);
    const initiatorDelivery = await prisma.notificationRecipient.findFirst({
      where: {
        userId: engineer.id,
        event: { actId, type: 'ACT_CLOSURE_WITHOUT_INSPECTION_REQUESTED' },
      },
    });
    expect(initiatorDelivery).not.toBeNull();
    const listed = await read(session, '/api/notifications');
    expect(listed.statusCode, JSON.stringify(listed.json())).toBe(200);
    expect(
      (listed.json() as { items: Array<{ type: string }> }).items.map((item) => item.type),
    ).toContain('ACT_CLOSURE_WITHOUT_INSPECTION_REQUESTED');
    for (const call of [
      mutate(managerSession, {
        method: 'POST',
        url: `/api/acts/${actId}/close-without-inspection`,
        payload: { expectedVersion: visible.version, reason: 'Руководитель закрывает' },
      }),
      mutate(managerSession, {
        method: 'POST',
        url: `/api/acts/${actId}/close-without-inspection/requests`,
        payload: { reason: 'Руководитель просит' },
      }),
      mutate(managerSession, {
        method: 'POST',
        url: `/api/acts/${actId}/close-without-inspection/decisions`,
        payload: {
          requestId: (requested.json() as { id: string }).id,
          expectedVersion: visible.version,
          defectFingerprint: visible.defectFingerprint,
          decision: 'APPROVE',
        },
      }),
    ]) {
      expect((await call).statusCode).toBe(403);
    }
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: `/api/acts/${actId}/close-without-inspection`,
          payload: { expectedVersion: visible.version, reason: 'Обход администратором' },
        })
      ).statusCode,
    ).toBe(409);
    const approverView = detailOf(await read(approverSession, `/api/acts/${actId}`));
    expect(approverView.closureRequest?.canDecide).toBe(true);
    expect(detailOf(await read(adminSession, `/api/acts/${actId}`)).closureRequest?.canDecide).toBe(
      false,
    );
    expect(detailOf(await read(session, `/api/acts/${actId}`)).closureRequest?.canDecide).toBe(
      false,
    );
    const rejected = await mutate(approverSession, {
      method: 'POST',
      url: `/api/acts/${actId}/close-without-inspection/decisions`,
      payload: {
        requestId: approverView.closureRequest!.id,
        expectedVersion: approverView.version,
        defectFingerprint: approverView.defectFingerprint,
        decision: 'REJECT',
      },
    });
    expect(rejected.statusCode).toBe(400);
    const refusal = await mutate(approverSession, {
      method: 'POST',
      url: `/api/acts/${actId}/close-without-inspection/decisions`,
      payload: {
        requestId: approverView.closureRequest!.id,
        expectedVersion: approverView.version,
        defectFingerprint: approverView.defectFingerprint,
        decision: 'REJECT',
        reason: 'Нужна проверка',
      },
    });
    expect(refusal.statusCode).toBe(200);
    expect((await prisma.act.findUniqueOrThrow({ where: { id: actId } })).status).toBe(
      'IN_PROGRESS',
    );
    await dispatchAct(actId);
    const refusalNotice = await prisma.notificationEvent.findFirst({
      where: { actId, type: 'ACT_CLOSURE_WITHOUT_INSPECTION_REJECTED' },
    });
    expect(JSON.stringify(refusalNotice?.payload)).toContain('Нужна проверка');
    const second = await mutate(session, {
      method: 'POST',
      url: `/api/acts/${actId}/close-without-inspection/requests`,
      payload: { reason: 'Прошу закрыть повторно' },
    });
    expect(second.statusCode).toBe(200);
    const fresh = detailOf(await read(approverSession, `/api/acts/${actId}`));
    await prisma.defectItem.update({
      where: { id: fresh.defectItems[0]!.id },
      data: { location: 'Кухня изменена', version: { increment: 1 } },
    });
    expect(
      (
        await mutate(approverSession, {
          method: 'POST',
          url: `/api/acts/${actId}/close-without-inspection/decisions`,
          payload: {
            requestId: fresh.closureRequest!.id,
            expectedVersion: fresh.version,
            defectFingerprint: fresh.defectFingerprint,
            decision: 'APPROVE',
          },
        })
      ).statusCode,
    ).toBe(409);
    const current = detailOf(await read(approverSession, `/api/acts/${actId}`));
    const approved = await mutate(approverSession, {
      method: 'POST',
      url: `/api/acts/${actId}/close-without-inspection/decisions`,
      payload: {
        requestId: current.closureRequest!.id,
        expectedVersion: current.version,
        defectFingerprint: current.defectFingerprint,
        decision: 'APPROVE',
      },
    });
    expect(approved.statusCode).toBe(200);
    const stored = await prisma.act.findUniqueOrThrow({ where: { id: actId } });
    expect(stored.closureMethod).toBe('WITHOUT_INSPECTION');
    expect(stored.closedWithoutInspectionByUserId).toBe(approver.id);
    expect(stored.closedWithoutInspectionByUserId).not.toBe(engineer.id);
    const requestRow = await prisma.actClosureRequest.findFirstOrThrow({
      where: { actId, status: 'APPROVED' },
    });
    expect(requestRow.requestedByUserId).toBe(engineer.id);
    expect(requestRow.decidedByUserId).toBe(approver.id);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: actId, action: 'ACT_CLOSED_WITHOUT_INSPECTION' },
    });
    expect(audit.actorUserId).toBe(approver.id);
    expect(JSON.stringify(audit.newValue)).toContain(engineer.id);
    const closedDefect = await prisma.defectItem.findFirstOrThrow({ where: { actId } });
    expect(closedDefect.closureMethod).toBe('WITHOUT_INSPECTION');
    expect(closedDefect.acceptedAt).toBeNull();
    expect(closedDefect.readyAt).toBeNull();
    const before = (
      (await read(adminSession, '/api/analytics/overview')).json() as {
        closedWithoutInspection: number;
      }
    ).closedWithoutInspection;
    expect(before).toBeGreaterThan(0);
    expect(
      (
        await mutate(approverSession, {
          method: 'POST',
          url: `/api/acts/${actId}/close-without-inspection/decisions`,
          payload: {
            requestId: current.closureRequest!.id,
            expectedVersion: current.version,
            defectFingerprint: current.defectFingerprint,
            decision: 'REJECT',
            reason: 'Поздно',
          },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('routes the decision when assignments change and keeps one winner', async () => {
    const initiator = await createUser('RESPONSIBLE_ENGINEER');
    const first = await createUser('RESPONSIBLE_ENGINEER');
    const second = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await createUser('ADMIN');
    const sgr = await createUser('SGR_MANAGER');
    const initiatorSession = await login(initiator.email);
    const firstSession = await login(first.email);
    const secondSession = await login(second.email);
    const adminSession = await login(admin.email);
    const sgrSession = await login(sgr.email);
    const catalog = await startedAct(initiatorSession, [initiator.id, first.id]);
    const actId = createdActIds.at(-1)!;
    await unassign(catalog.object.id, [initiator.id]);
    const requested = await mutate(initiatorSession, {
      method: 'POST',
      url: `/api/acts/${actId}/close-without-inspection/requests`,
      payload: { reason: 'Прошу согласовать' },
    });
    expect(requested.statusCode).toBe(200);
    const requestId = (requested.json() as { id: string }).id;
    await assign(catalog.object.id, [initiator.id]);
    const selfView = detailOf(await read(initiatorSession, `/api/acts/${actId}`));
    expect(selfView.closureRequest?.canDecide).toBe(false);
    expect(
      (
        await mutate(initiatorSession, {
          method: 'POST',
          url: `/api/acts/${actId}/close-without-inspection/decisions`,
          payload: {
            requestId,
            expectedVersion: selfView.version,
            defectFingerprint: selfView.defectFingerprint,
            decision: 'APPROVE',
          },
        })
      ).statusCode,
    ).toBe(403);
    await unassign(catalog.object.id, [first.id, second.id, initiator.id]);
    const adminView = detailOf(await read(adminSession, `/api/acts/${actId}`));
    expect(adminView.closureRequest?.canDecide).toBe(true);
    expect(detailOf(await read(sgrSession, `/api/acts/${actId}`)).closureRequest?.canDecide).toBe(
      true,
    );
    await assign(catalog.object.id, [first.id]);
    expect(detailOf(await read(adminSession, `/api/acts/${actId}`)).closureRequest?.canDecide).toBe(
      false,
    );
    await dispatchAct(actId);
    const noticesBefore = await prisma.notificationRecipient.count({
      where: {
        userId: second.id,
        event: { actId, type: 'ACT_CLOSURE_WITHOUT_INSPECTION_REQUESTED' },
      },
    });
    expect(noticesBefore).toBe(0);
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: `/api/users/${second.id}/object-assignments`,
          payload: { objectId: catalog.object.id },
        })
      ).statusCode,
    ).toBe(201);
    await dispatchAct(actId);
    const noticesAfter = await prisma.notificationRecipient.count({
      where: {
        userId: second.id,
        event: { actId, type: 'ACT_CLOSURE_WITHOUT_INSPECTION_REQUESTED' },
      },
    });
    expect(noticesAfter).toBeGreaterThan(0);
    const left = detailOf(await read(firstSession, `/api/acts/${actId}`));
    const right = detailOf(await read(secondSession, `/api/acts/${actId}`));
    const [winner, loser] = await Promise.all([
      mutate(firstSession, {
        method: 'POST',
        url: `/api/acts/${actId}/close-without-inspection/decisions`,
        payload: {
          requestId,
          expectedVersion: left.version,
          defectFingerprint: left.defectFingerprint,
          decision: 'APPROVE',
        },
      }),
      mutate(secondSession, {
        method: 'POST',
        url: `/api/acts/${actId}/close-without-inspection/decisions`,
        payload: {
          requestId,
          expectedVersion: right.version,
          defectFingerprint: right.defectFingerprint,
          decision: 'REJECT',
          reason: 'Не согласен',
        },
      }),
    ]);
    const statuses = [winner.statusCode, loser.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    expect(
      await prisma.actClosureRequest.count({ where: { actId, status: 'APPROVED' } }),
    ).toBeLessThanOrEqual(1);
    const decisions = await prisma.auditLog.count({
      where: {
        entityId: actId,
        action: {
          in: [
            'ACT_CLOSURE_WITHOUT_INSPECTION_APPROVED',
            'ACT_CLOSURE_WITHOUT_INSPECTION_REJECTED',
          ],
        },
      },
    });
    expect(decisions).toBe(1);
  });

  it('lets ADMIN or SGR_MANAGER decide only without engineers and keeps SUPER_ADMIN', async () => {
    const initiator = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await createUser('ADMIN');
    const sgr = await createUser('SGR_MANAGER');
    const superAdmin =
      (await prisma.user.findFirst({
        where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
      })) ?? (await createUser('SUPER_ADMIN'));
    const initiatorSession = await login(initiator.email);
    const adminSession = await login(admin.email);
    const sgrSession = await login(sgr.email);
    const superSession = await login(superAdmin.email);
    const catalog = await startedAct(initiatorSession, [initiator.id]);
    const actId = createdActIds.at(-1)!;
    await unassign(catalog.object.id, [initiator.id]);
    expect(
      (
        await mutate(initiatorSession, {
          method: 'POST',
          url: `/api/acts/${actId}/close-without-inspection/requests`,
          payload: { reason: 'Ответственных нет' },
        })
      ).statusCode,
    ).toBe(200);
    const view = detailOf(await read(sgrSession, `/api/acts/${actId}`));
    expect(view.closureRequest?.canDecide).toBe(true);
    const refused = await mutate(sgrSession, {
      method: 'POST',
      url: `/api/acts/${actId}/close-without-inspection/decisions`,
      payload: {
        requestId: view.closureRequest!.id,
        expectedVersion: view.version,
        defectFingerprint: view.defectFingerprint,
        decision: 'REJECT',
        reason: 'Рано закрывать',
      },
    });
    expect(refused.statusCode).toBe(200);
    const replacement = await startedAct(initiatorSession, [initiator.id]);
    const secondId = createdActIds.at(-1)!;
    await unassign(replacement.object.id, [initiator.id]);
    await mutate(initiatorSession, {
      method: 'POST',
      url: `/api/acts/${secondId}/close-without-inspection/requests`,
      payload: { reason: 'Пусть закроет администратор' },
    });
    const adminView = detailOf(await read(adminSession, `/api/acts/${secondId}`));
    const approved = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${secondId}/close-without-inspection/decisions`,
      payload: {
        requestId: adminView.closureRequest!.id,
        expectedVersion: adminView.version,
        defectFingerprint: adminView.defectFingerprint,
        decision: 'APPROVE',
      },
    });
    expect(approved.statusCode).toBe(200);
    await dispatchAct(secondId);
    const approvedNotice = await prisma.notificationEvent.findFirst({
      where: { actId: secondId, type: 'ACT_CLOSURE_WITHOUT_INSPECTION_APPROVED' },
    });
    expect(JSON.stringify(approvedNotice?.payload)).toContain('согласовал');
    const bypass = await startedAct(initiatorSession, [initiator.id]);
    const thirdId = createdActIds.at(-1)!;
    await unassign(bypass.object.id, [initiator.id]);
    await mutate(initiatorSession, {
      method: 'POST',
      url: `/api/acts/${thirdId}/close-without-inspection/requests`,
      payload: { reason: 'Для суперадминистратора' },
    });
    const superView = detailOf(await read(superSession, `/api/acts/${thirdId}`));
    expect(
      (
        await mutate(superSession, {
          method: 'POST',
          url: `/api/acts/${thirdId}/close-without-inspection`,
          payload: { expectedVersion: superView.version, reason: 'Полный доступ' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await prisma.actClosureRequest.findFirstOrThrow({ where: { actId: thirdId } })).status,
    ).toBe('OBSOLETE');
    const cancelled = await startedAct(initiatorSession, [initiator.id]);
    const fourthId = createdActIds.at(-1)!;
    await unassign(cancelled.object.id, [initiator.id]);
    await mutate(initiatorSession, {
      method: 'POST',
      url: `/api/acts/${fourthId}/close-without-inspection/requests`,
      payload: { reason: 'До аннулирования' },
    });
    const cancelView = detailOf(await read(adminSession, `/api/acts/${fourthId}`));
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: `/api/acts/${fourthId}/cancel`,
          payload: { expectedVersion: cancelView.version, reason: 'Акт не нужен' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: `/api/acts/${fourthId}/close-without-inspection/decisions`,
          payload: {
            requestId: cancelView.closureRequest!.id,
            expectedVersion: cancelView.version,
            defectFingerprint: cancelView.defectFingerprint,
            decision: 'APPROVE',
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await prisma.actClosureRequest.findFirstOrThrow({ where: { actId: fourthId } })).status,
    ).toBe('OBSOLETE');
    expect(
      (await prisma.act.findUniqueOrThrow({ where: { id: fourthId } })).closureMethod,
    ).toBeNull();
  });
});
