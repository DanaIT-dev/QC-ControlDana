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
import { NotificationDispatcher, NOTIFICATION_QUEUE } from '@sgr-registry/jobs';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/configure-http';
import { hashArgon2id } from '../../src/auth/crypto';
import type { UserRole } from '@sgr-registry/contracts';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

let app: NestFastifyApplication;
let prisma: PrismaClient;
let redis: Redis;
let dispatcher: NotificationDispatcher;
let notificationQueue: Queue;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdWorkTypeIds: string[] = [];
const createdDefectTypeIds: string[] = [];
const createdObjectIds: string[] = [];
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
      'x-request-id': `dir-${Date.now()}-${Math.random()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(role: UserRole) {
  const email = `dir.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: {
      ...personNameWriteFields(`Directory ${role}`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
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

async function ensureActiveSuperAdmin() {
  const existing = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
  });
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { mustChangePassword: false },
    });
    await upsertUserCredentials(prisma, {
      userId: existing.id,
      passwordHash: await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 }),
    });
    return existing;
  }
  return createUser('SUPER_ADMIN');
}

async function login(email: string) {
  const response = await inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: DEMO_PASSWORD },
  });
  const body = response.json() as { csrfToken: string };
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value ?? '';
  return { cookie, csrfToken: body.csrfToken };
}

async function mutate(
  session: { cookie: string; csrfToken: string },
  opts: { method: 'POST' | 'PATCH'; url: string; payload?: unknown },
) {
  return inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload ?? {},
    cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    headers: { [CSRF_HEADER_NAME]: session.csrfToken },
  });
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
    const leftover = await prisma.outboxEvent.count({
      where: { status: { in: ['PENDING', 'FAILED'] }, availableAt: { lte: new Date() } },
    });
    if (leftover === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('directory quick create', () => {
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
      await prisma.proposal.deleteMany({
        where: { defectItem: { actId: { in: createdActIds } } },
      });
      await prisma.defectItemEngineer.deleteMany({
        where: { defectItem: { actId: { in: createdActIds } } },
      });
      await prisma.defectItemLiableOrganization.deleteMany({
        where: { defectItem: { actId: { in: createdActIds } } },
      });
      await prisma.defectItem.deleteMany({ where: { actId: { in: createdActIds } } });
      await prisma.act.deleteMany({ where: { id: { in: createdActIds } } });
    }
    if (createdOrgIds.length > 0) {
      await prisma.notificationRecipient.deleteMany({
        where: {
          event: {
            occurrenceKey: {
              in: createdOrgIds.map((id) => `ORGANIZATION_DETAILS_INCOMPLETE:${id}`),
            },
          },
        },
      });
      await prisma.notificationEvent.deleteMany({
        where: {
          occurrenceKey: {
            in: createdOrgIds.map((id) => `ORGANIZATION_DETAILS_INCOMPLETE:${id}`),
          },
        },
      });
      await prisma.organizationRoleAssignment.deleteMany({
        where: { organizationId: { in: createdOrgIds } },
      });
      await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
    if (createdWorkTypeIds.length > 0) {
      await prisma.workType.deleteMany({ where: { id: { in: createdWorkTypeIds } } });
    }
    if (createdDefectTypeIds.length > 0) {
      await prisma.defectType.deleteMany({ where: { id: { in: createdDefectTypeIds } } });
    }
    if (createdObjectIds.length > 0) {
      await prisma.propertyObjectEngineer.deleteMany({
        where: { propertyObjectId: { in: createdObjectIds } },
      });
      await prisma.propertyObject.deleteMany({ where: { id: { in: createdObjectIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.notificationRecipient.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.propertyObjectEngineer.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.idempotencyRecord.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only',
      );
      try {
        await prisma.auditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
      } finally {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only',
        );
      }
      await prisma.user.updateMany({
        where: { id: { in: createdUserIds }, role: 'SUPER_ADMIN' },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await notificationQueue.close();
    await app.close();
    await redis.quit();
    await disconnectPrismaClient();
  });

  it('creates organizations, work types and defect types with notifications and access control', async () => {
    const admin = await createUser('ADMIN');
    const manager = await createUser('MANAGER');
    const sgr = await createUser('SGR_MANAGER');
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const superAdmin = await ensureActiveSuperAdmin();
    const adminSession = await login(admin.email);
    const managerSession = await login(manager.email);
    const sgrSession = await login(sgr.email);
    const engineerSession = await login(engineer.email);
    const contractorSession = await login(contractor.email);
    const superSession = await login(superAdmin.email);
    const stamp = Date.now();
    const orgName = `ООО Быстрая ${stamp}`;

    expect(
      (
        await inject({
          method: 'POST',
          url: '/api/reference-data/organizations',
          payload: { officialName: orgName, roles: ['CUSTOMER'] },
        })
      ).statusCode,
    ).toBe(401);

    const createdOrg = await mutate(adminSession, {
      method: 'POST',
      url: '/api/reference-data/organizations',
      payload: { officialName: orgName, roles: ['CUSTOMER'] },
    });
    expect(createdOrg.statusCode).toBe(201);
    const orgBody = createdOrg.json() as { id: string; officialName: string; active: boolean };
    createdOrgIds.push(orgBody.id);
    expect(orgBody.active).toBe(true);
    expect(
      await prisma.auditLog.count({
        where: { entityId: orgBody.id, action: 'ORGANIZATION_CREATED' },
      }),
    ).toBe(1);
    await drain();
    const listed = await inject({
      method: 'GET',
      url: '/api/notifications?filter=unread',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    const items = (
      listed.json() as {
        items: Array<{ type: string; body: string; organizationId: string | null }>;
      }
    ).items;
    const incomplete = items.filter(
      (item) =>
        item.type === 'ORGANIZATION_DETAILS_INCOMPLETE' && item.organizationId === orgBody.id,
    );
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.body).toContain(`Заполните подробные данные организации «${orgName}»`);
    expect(incomplete[0]?.body).toContain('УНП');

    const again = await mutate(adminSession, {
      method: 'POST',
      url: '/api/reference-data/organizations',
      payload: { officialName: `  ${orgName.toUpperCase()}  `, roles: ['CUSTOMER'] },
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { existing?: { id: string } }).existing?.id).toBe(orgBody.id);
    await drain();
    const listedAgain = await inject({
      method: 'GET',
      url: '/api/notifications?filter=unread',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(
      (
        listedAgain.json() as {
          items: Array<{ type: string; organizationId: string | null }>;
        }
      ).items.filter(
        (item) =>
          item.type === 'ORGANIZATION_DETAILS_INCOMPLETE' && item.organizationId === orgBody.id,
      ),
    ).toHaveLength(1);

    const current = await prisma.organization.findUniqueOrThrow({ where: { id: orgBody.id } });
    const filled = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/reference-data/organizations/${orgBody.id}`,
      payload: {
        expectedVersion: current.version,
        officialName: orgName,
        unp: `9${String(stamp).slice(-8)}`,
        postalAddress: 'Минск',
        email: `org.${stamp}@example.sgr.local`,
        phone: '+375 17 000 00 00',
        contactPerson: 'Иванов И.И.',
      },
    });
    expect(filled.statusCode).toBe(200);
    await drain();
    const afterFill = await inject({
      method: 'GET',
      url: '/api/notifications?filter=unread',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(
      (
        afterFill.json() as {
          items: Array<{ type: string; organizationId: string | null }>;
        }
      ).items.filter(
        (item) =>
          item.type === 'ORGANIZATION_DETAILS_INCOMPLETE' && item.organizationId === orgBody.id,
      ),
    ).toHaveLength(0);

    const workName = `Вид работ ${stamp}`;
    const work = await mutate(managerSession, {
      method: 'POST',
      url: '/api/reference-data/work-types',
      payload: { name: workName },
    });
    expect(work.statusCode).toBe(201);
    const workBody = work.json() as { id: string; name: string; active: boolean };
    createdWorkTypeIds.push(workBody.id);
    expect(workBody.active).toBe(true);
    expect(
      await prisma.auditLog.count({
        where: { entityId: workBody.id, action: 'WORK_TYPE_CREATED' },
      }),
    ).toBe(1);
    const workDup = await mutate(managerSession, {
      method: 'POST',
      url: '/api/reference-data/work-types',
      payload: { name: ` ${workName.toUpperCase()} ` },
    });
    expect(workDup.statusCode).toBe(409);
    expect((workDup.json() as { existing?: { id: string } }).existing?.id).toBe(workBody.id);

    const defectName = `Вид дефекта ${stamp}`;
    const defect = await mutate(sgrSession, {
      method: 'POST',
      url: '/api/reference-data/defect-types',
      payload: { name: defectName },
    });
    expect(defect.statusCode).toBe(201);
    const defectBody = defect.json() as { id: string };
    createdDefectTypeIds.push(defectBody.id);
    expect(
      await prisma.auditLog.count({
        where: { entityId: defectBody.id, action: 'DEFECT_TYPE_CREATED' },
      }),
    ).toBe(1);

    const concurrentName = `Гонка ${stamp}`;
    const concurrent = await Promise.all(
      [1, 2].map(() =>
        mutate(adminSession, {
          method: 'POST',
          url: '/api/reference-data/work-types',
          payload: { name: concurrentName },
        }),
      ),
    );
    const created = concurrent.filter((item) => item.statusCode === 201);
    const conflicts = concurrent.filter((item) => item.statusCode === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    createdWorkTypeIds.push((created[0]?.json() as { id: string }).id);

    for (const session of [engineerSession, contractorSession]) {
      const deniedOrg = await mutate(session, {
        method: 'POST',
        url: '/api/reference-data/organizations',
        payload: { officialName: `Denied ${stamp}` },
      });
      expect(deniedOrg.statusCode).toBe(403);
      expect(
        (
          await mutate(session, {
            method: 'POST',
            url: '/api/reference-data/work-types',
            payload: { name: `Denied ${stamp}` },
          })
        ).statusCode,
      ).toBe(403);
    }

    const lookups = await inject({
      method: 'GET',
      url: '/api/operations/lookups',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(lookups.statusCode).toBe(200);
    const lookupBody = lookups.json() as {
      canCreate: Record<string, boolean>;
      customers: Array<{ id: string }>;
      workTypes: Array<{ id: string }>;
      defectTypes: Array<{ id: string }>;
      responsibleEngineers: Array<{ id: string; fullName: string; email?: string }>;
    };
    expect(lookupBody.canCreate).toMatchObject({
      propertyObject: true,
      organization: true,
      workType: true,
      defectType: true,
    });
    expect(lookupBody.customers.some((item) => item.id === orgBody.id)).toBe(true);
    expect(lookupBody.workTypes.some((item) => item.id === workBody.id)).toBe(true);
    expect(lookupBody.defectTypes.some((item) => item.id === defectBody.id)).toBe(true);
    expect(lookupBody.responsibleEngineers.every((item) => item.email === undefined)).toBe(true);
    expect(JSON.stringify(lookupBody.responsibleEngineers)).not.toMatch(/@/);

    const engineerLookups = await inject({
      method: 'GET',
      url: '/api/operations/lookups',
      cookies: { [SESSION_COOKIE_NAME]: engineerSession.cookie },
    });
    expect(
      (engineerLookups.json() as { canCreate: Record<string, boolean> }).canCreate,
    ).toMatchObject({
      propertyObject: false,
      organization: false,
      workType: false,
      defectType: false,
      responsibleEngineer: false,
    });
    const superLookups = await inject({
      method: 'GET',
      url: '/api/operations/lookups',
      cookies: { [SESSION_COOKIE_NAME]: superSession.cookie },
    });
    expect((superLookups.json() as { canCreate: Record<string, boolean> }).canCreate).toMatchObject(
      {
        propertyObject: true,
        organization: true,
        workType: true,
        defectType: true,
      },
    );
  });

  it('keeps an archived object on an existing act and hides it from new-act lookups', async () => {
    const admin = await createUser('ADMIN');
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const adminSession = await login(admin.email);
    const stamp = Date.now();
    const object = await prisma.propertyObject.create({
      data: { name: `Архив акт ${stamp}`, address: 'ул. Старая, 1' },
    });
    createdObjectIds.push(object.id);
    await prisma.propertyObjectEngineer.create({
      data: { propertyObjectId: object.id, userId: engineer.id },
    });
    const customer = await prisma.organization.create({
      data: {
        officialName: `Заказчик архив ${stamp}`,
        roles: { create: [{ role: 'CUSTOMER' }] },
      },
    });
    createdOrgIds.push(customer.id);
    const defectType = await prisma.defectType.create({
      data: { code: `ARCH-${stamp}`, name: `Архив дефект ${stamp}`, sortOrder: 90 },
    });
    createdDefectTypeIds.push(defectType.id);
    const act = await inject({
      method: 'POST',
      url: '/api/acts',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: {
        [CSRF_HEADER_NAME]: adminSession.csrfToken,
        'idempotency-key': `dir-act-${stamp}`,
      },
      payload: {
        formCode: 'S1',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-08-20',
        defectItems: [
          {
            location: 'Кв. 1',
            defectTypeId: defectType.id,
            claimDetails: 'Течь',
            responsibleEngineerIds: [engineer.id],
            liableOrganizationIds: [],
          },
        ],
      },
    });
    expect(act.statusCode).toBe(201);
    const actId = (act.json() as { id: string }).id;
    createdActIds.push(actId);

    const archived = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/objects/${object.id}`,
      payload: {
        expectedVersion: object.version,
        name: object.name,
        address: object.address,
        active: false,
      },
    });
    expect(archived.statusCode).toBe(200);

    const lookups = await inject({
      method: 'GET',
      url: '/api/operations/lookups',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(
      (lookups.json() as { propertyObjects: Array<{ id: string }> }).propertyObjects.some(
        (item) => item.id === object.id,
      ),
    ).toBe(false);

    const detail = await inject({
      method: 'GET',
      url: `/api/acts/${actId}`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { objectId: string; objectName?: string }).objectId).toBe(object.id);
  });
});
