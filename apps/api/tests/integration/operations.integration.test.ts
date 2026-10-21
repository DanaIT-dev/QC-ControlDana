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
  addCalendarDays,
  calendarDateInTimeZone,
  personNameWriteFields,
} from '@sgr-registry/domain';
import Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/configure-http';
import { hashArgon2id } from '../../src/auth/crypto';
import type { UserRole } from '@sgr-registry/contracts';

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
      'x-request-id': `ops-${Date.now()}-${Math.random()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(
  role: UserRole,
  extras: { mustChangePassword?: boolean; status?: 'ACTIVE' | 'ARCHIVED' } = {},
) {
  const email = `ops.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: {
      ...personNameWriteFields(`Операции ${role}`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
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

async function ensureActiveSuperAdmin() {
  const existing = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
  });
  if (!existing) {
    return createUser('SUPER_ADMIN');
  }
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

async function login(email: string, password = DEMO_PASSWORD) {
  const response = await inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  const body = response.json() as { csrfToken: string; id: string; mustChangePassword?: boolean };
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

async function read(session: { cookie: string }, url: string) {
  return inject({
    method: 'GET',
    url,
    cookies: { [SESSION_COOKIE_NAME]: session.cookie },
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
      email: `cust-${suffix}@example.sgr.local`,
      phone: '1',
      contactPerson: 'К',
      roles: { create: [{ role: 'CUSTOMER' }] },
    },
  });
  const liable = await prisma.organization.create({
    data: {
      officialName: `Подрядчик ${suffix}`,
      postalAddress: 'addr',
      email: `liable-${suffix}@example.sgr.local`,
      phone: '1',
      contactPerson: 'П',
      roles: { create: [{ role: 'LIABLE_CONTRACTOR' }] },
    },
  });
  const alt = await prisma.organization.create({
    data: {
      officialName: `Альтернатива ${suffix}`,
      postalAddress: 'addr',
      email: `alt-${suffix}@example.sgr.local`,
      phone: '1',
      contactPerson: 'А',
      roles: { create: [{ role: 'ALTERNATIVE_CONTRACTOR' }] },
    },
  });
  const defectType = await prisma.defectType.create({
    data: { code: `OPS-${suffix}`, name: `Дефект ${suffix}`, sortOrder: 50 },
  });
  return { object, customer, liable, alt, defectType };
}

async function assignObjectEngineers(objectId: string, userIds: string[]) {
  if (userIds.length === 0) {
    return;
  }
  await prisma.propertyObjectEngineer.createMany({
    data: userIds.map((userId) => ({ propertyObjectId: objectId, userId })),
    skipDuplicates: true,
  });
}

describe('operations integration', () => {
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
    const actIds = createdActIds.filter((id) => typeof id === 'string' && id.length > 0);
    if (actIds.length > 0) {
      await prisma.emailDelivery.deleteMany({
        where: { recipient: { event: { actId: { in: actIds } } } },
      });
      await prisma.notificationRecipient.deleteMany({
        where: { event: { actId: { in: actIds } } },
      });
      await prisma.notificationEvent.deleteMany({ where: { actId: { in: actIds } } });
      await prisma.slaClock.deleteMany({ where: { defectItem: { actId: { in: actIds } } } });
      await prisma.proposal.deleteMany({
        where: { defectItem: { actId: { in: actIds } } },
      });
      await prisma.defectItemEngineer.deleteMany({
        where: { defectItem: { actId: { in: actIds } } },
      });
      await prisma.defectItemLiableOrganization.deleteMany({
        where: { defectItem: { actId: { in: actIds } } },
      });
      await prisma.defectItem.deleteMany({ where: { actId: { in: actIds } } });
      await prisma.act.deleteMany({ where: { id: { in: actIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.userOrganizationMembership.deleteMany({
        where: {
          OR: [
            { userId: { in: createdUserIds } },
            { assignedByUserId: { in: createdUserIds } },
            { revokedByUserId: { in: createdUserIds } },
          ],
        },
      });
      await prisma.propertyObjectEngineer.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
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

  it('enforces user management, temporary password hashing and last admin protection', async () => {
    const admin = await createUser('ADMIN');
    const manager = await createUser('SGR_MANAGER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const adminSession = await login(admin.email);
    const managerSession = await login(manager.email);
    const contractorSession = await login(contractor.email);

    const created = await mutate(adminSession, {
      method: 'POST',
      url: '/api/users',
      payload: {
        lastName: 'Новый',
        firstName: 'Инженер',
        email: `new.${Date.now()}@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as {
      user: { id: string; email: string; mustChangePassword: boolean; version: number };
      temporaryPassword: string;
    };
    createdUserIds.push(createdBody.user.id);
    expect(createdBody.temporaryPassword.length).toBeGreaterThanOrEqual(12);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: createdBody.user.id },
      include: { credentials: true },
    });
    expect(stored.credentials?.passwordHash).not.toBe(createdBody.temporaryPassword);
    expect(stored.mustChangePassword).toBe(true);
    const logs = await prisma.auditLog.findMany({ where: { entityId: createdBody.user.id } });
    expect(JSON.stringify(logs)).not.toMatch(
      /passwordHash|temporaryPassword|csrfToken|sgr_session/,
    );

    expect(
      (
        await mutate(managerSession, {
          method: 'POST',
          url: '/api/users',
          payload: { fullName: 'X', email: 'x@example.sgr.local', role: 'ADMIN' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(contractorSession, {
          method: 'POST',
          url: '/api/users',
          payload: { fullName: 'X', email: 'y@example.sgr.local', role: 'ADMIN' },
        })
      ).statusCode,
    ).toBe(403);

    const blocked = await login(createdBody.user.email, createdBody.temporaryPassword);
    expect(blocked.body.mustChangePassword).toBe(true);
    const registryBlocked = await inject({
      method: 'GET',
      url: '/api/registry/defects',
      cookies: { [SESSION_COOKIE_NAME]: blocked.cookie },
    });
    expect(registryBlocked.statusCode).toBe(403);

    const changed = await mutate(blocked, {
      method: 'POST',
      url: '/api/auth/change-password',
      payload: {
        currentPassword: createdBody.temporaryPassword,
        newPassword: 'Dana-SGR-New-2026!',
      },
    });
    expect(changed.statusCode).toBe(200);
    const changedBody = changed.json() as { csrfToken: string };
    const profile = await mutate(
      {
        cookie: changed.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value ?? '',
        body: { csrfToken: changedBody.csrfToken },
      },
      {
        method: 'POST',
        url: '/api/users/me/complete-profile',
        payload: {
          lastName: 'Новый',
          firstName: 'Инженер',
          phone: '+375291112233',
          birthDate: '1990-01-15',
        },
      },
    );
    expect(profile.statusCode).toBe(200);
    const restored = await inject({
      method: 'GET',
      url: '/api/registry/defects',
      cookies: {
        [SESSION_COOKIE_NAME]:
          changed.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value ?? '',
      },
    });
    expect(restored.statusCode).toBe(200);

    const roleChange = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/users/${manager.id}`,
      payload: { expectedVersion: manager.version, role: 'CONTRACTOR_ENGINEER' },
    });
    expect(roleChange.statusCode).toBe(200);
    const staleManager = await inject({
      method: 'GET',
      url: '/api/registry/defects',
      cookies: { [SESSION_COOKIE_NAME]: managerSession.cookie },
    });
    expect(staleManager.statusCode).toBe(401);

    const archiveSelf = await mutate(adminSession, {
      method: 'POST',
      url: `/api/users/${admin.id}/archive`,
      payload: { expectedVersion: 1 },
    });
    expect(archiveSelf.statusCode).toBe(409);

    const archivedUser = await createUser('RESPONSIBLE_ENGINEER');
    const archivedFresh = await prisma.user.findUniqueOrThrow({ where: { id: archivedUser.id } });
    await mutate(adminSession, {
      method: 'POST',
      url: `/api/users/${archivedUser.id}/archive`,
      payload: { expectedVersion: archivedFresh.version },
    });
    const archivedLogin = await login(archivedUser.email);
    expect(archivedLogin.response.statusCode).toBe(401);
  });

  it('manages reference data with 403 for other roles and keeps archived values in history', async () => {
    const admin = await createUser('ADMIN');
    const manager = await createUser('SGR_MANAGER');
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const adminSession = await login(admin.email);
    const managerSession = await login(manager.email);
    const engineerSession = await login(engineer.email);
    const created = await mutate(adminSession, {
      method: 'POST',
      url: '/api/reference-data/property-objects',
      payload: { name: `Объект ops ${Date.now()}`, address: 'Минск, тестовая' },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as { id: string; version: number; name: string };
    const managerCreate = await mutate(managerSession, {
      method: 'POST',
      url: '/api/reference-data/work-types',
      payload: { code: `WT${Date.now()}`, name: `Вид ${Date.now()}` },
    });
    expect(managerCreate.statusCode).toBe(201);
    expect(
      (
        await mutate(engineerSession, {
          method: 'POST',
          url: '/api/reference-data/property-objects',
          payload: { name: 'Нет', address: 'Нет' },
        })
      ).statusCode,
    ).toBe(403);
    const archived = await mutate(adminSession, {
      method: 'POST',
      url: `/api/reference-data/property-objects/${createdBody.id}/archive`,
      payload: { expectedVersion: createdBody.version },
    });
    expect(archived.statusCode).toBe(200);
    const stillThere = await prisma.propertyObject.findUnique({ where: { id: createdBody.id } });
    expect(stillThere?.active).toBe(false);
  });

  it('lets RESPONSIBLE_ENGINEER read objects and organizations but not mutate catalogs', async () => {
    const admin = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const adminSession = await login(admin.email);
    const responsibleSession = await login(responsible.email);
    const contractorSession = await login(contractor.email);
    const created = await mutate(adminSession, {
      method: 'POST',
      url: '/api/reference-data/property-objects',
      payload: { name: `Объект view ${Date.now()}`, address: 'Минск, просмотр' },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as {
      id: string;
      version: number;
      name: string;
      address: string;
    };
    const unassigned = await read(
      responsibleSession,
      `/api/reference-data/property-objects?search=${encodeURIComponent(createdBody.name)}`,
    );
    expect(unassigned.statusCode).toBe(200);
    expect(
      (unassigned.json() as { items: Array<{ id: string }> }).items.some(
        (item) => item.id === createdBody.id,
      ),
    ).toBe(false);
    await assignObjectEngineers(createdBody.id, [responsible.id]);
    const objects = await read(
      responsibleSession,
      `/api/reference-data/property-objects?search=${encodeURIComponent(createdBody.name)}`,
    );
    expect(objects.statusCode).toBe(200);
    const objectItems = (
      objects.json() as { items: Array<{ id: string; name: string; address: string }> }
    ).items;
    expect(
      objectItems.some((item) => item.id === createdBody.id && item.address === 'Минск, просмотр'),
    ).toBe(true);
    const orgs = await read(responsibleSession, '/api/reference-data/organizations');
    expect(orgs.statusCode).toBe(200);
    expect((orgs.json() as { items: unknown[] }).items).toBeDefined();
    expect((await read(responsibleSession, '/api/reference-data/work-types')).statusCode).toBe(403);
    expect((await read(responsibleSession, '/api/reference-data/defect-types')).statusCode).toBe(
      403,
    );
    expect(
      (
        await read(
          responsibleSession,
          `/api/reference-data/property-objects/${createdBody.id}/history`,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(responsibleSession, {
          method: 'POST',
          url: '/api/reference-data/property-objects',
          payload: { name: 'Нет', address: 'Нет' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(responsibleSession, {
          method: 'PATCH',
          url: `/api/reference-data/property-objects/${createdBody.id}`,
          payload: {
            expectedVersion: createdBody.version,
            name: 'Взлом',
            address: 'Взлом',
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(responsibleSession, {
          method: 'POST',
          url: `/api/reference-data/property-objects/${createdBody.id}/archive`,
          payload: { expectedVersion: createdBody.version },
        })
      ).statusCode,
    ).toBe(403);
    expect((await read(contractorSession, '/api/reference-data/property-objects')).statusCode).toBe(
      403,
    );
    expect(
      (
        await mutate(contractorSession, {
          method: 'POST',
          url: '/api/reference-data/organizations',
          payload: {
            officialName: 'Нет',
            postalAddress: 'Нет',
            email: 'no@example.sgr.local',
            phone: '1',
            contactPerson: 'Нет',
            roles: ['CUSTOMER'],
          },
        })
      ).statusCode,
    ).toBe(403);
    const afterDenied = await prisma.propertyObject.findUnique({ where: { id: createdBody.id } });
    expect(afterDenied?.name).toBe(createdBody.name);
  });

  it('creates acts with idempotency, unique numbers and assignment scope', async () => {
    const admin = await createUser('ADMIN');
    const manager = await createUser('SGR_MANAGER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const otherResponsible = await createUser('RESPONSIBLE_ENGINEER');
    const adminSession = await login(admin.email);
    const managerSession = await login(manager.email);
    const contractorSession = await login(contractor.email);
    const responsibleSession = await login(responsible.email);
    const { object, customer, liable, alt, defectType } = await catalogs();
    await assignObjectEngineers(object.id, [responsible.id]);
    const key = `idem-${Date.now()}`;
    const payload = {
      formCode: 'S1',
      objectId: object.id,
      customerOrganizationId: customer.id,
      issuedOn: '2026-08-20',
      defectItems: [
        {
          location: 'Кв. 1',
          defectTypeId: defectType.id,
          claimDetails: 'Течь',
          responsibleEngineerIds: [responsible.id],
          liableOrganizationIds: [liable.id],
          plannedDeadline: '2026-09-01',
        },
        {
          location: 'Кв. 2',
          defectTypeId: defectType.id,
          claimDetails: 'Окна',
          responsibleEngineerIds: [responsible.id],
          liableOrganizationIds: [liable.id],
        },
      ],
    };
    const first = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload,
      headers: { 'idempotency-key': key },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { id: string; officialNumber: string };
    createdActIds.push(firstBody.id);
    const retry = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload,
      headers: { 'idempotency-key': key },
    });
    expect(retry.statusCode).toBe(201);
    expect((retry.json() as { id: string }).id).toBe(firstBody.id);
    const conflict = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: { ...payload, issuedOn: '2026-08-21' },
      headers: { 'idempotency-key': key },
    });
    expect(conflict.statusCode).toBe(409);
    expect(
      (
        await mutate(contractorSession, {
          method: 'POST',
          url: '/api/acts',
          payload,
          headers: { 'idempotency-key': `other-${key}` },
        })
      ).statusCode,
    ).toBe(403);
    const stored = await prisma.act.findUnique({ where: { id: firstBody.id } });
    expect(stored?.objectId).toBe(object.id);
    expect(stored?.status).toBe('NEW');
    expect(stored?.startedAt).toBeNull();
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: '/api/acts',
          payload: { ...payload, objectName: 'Подмена', objectAddress: 'Чужой адрес' },
          headers: { 'idempotency-key': `spoof-${key}` },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: '/api/acts',
          payload: { ...payload, objectId: '00000000-0000-4000-8000-000000000099' },
          headers: { 'idempotency-key': `unknown-obj-${key}` },
        })
      ).statusCode,
    ).toBe(400);
    const archivedObject = await prisma.propertyObject.create({
      data: {
        name: `Архив ${key}`,
        address: 'архивный адрес',
        active: false,
        archivedAt: new Date(),
      },
    });
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: '/api/acts',
          payload: { ...payload, objectId: archivedObject.id },
          headers: { 'idempotency-key': `archived-obj-${key}` },
        })
      ).statusCode,
    ).toBe(400);
    const managerAct = await mutate(managerSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        ...payload,
        defectItems: [payload.defectItems[0]],
      },
      headers: { 'idempotency-key': `mgr-${key}` },
    });
    expect(managerAct.statusCode).toBe(201);
    createdActIds.push((managerAct.json() as { id: string }).id);

    const csrfMissing = await inject({
      method: 'POST',
      url: '/api/acts',
      payload,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: { 'idempotency-key': `csrf-${key}` },
    });
    expect(csrfMissing.statusCode).toBe(403);

    const unknownFields = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/acts/${firstBody.id}/header`,
      payload: { expectedVersion: 1, officialNumber: 'С-1-2026-999999' },
    });
    expect(unknownFields.statusCode).toBe(400);

    const assigned = await inject({
      method: 'GET',
      url: `/api/acts/${firstBody.id}`,
      cookies: { [SESSION_COOKIE_NAME]: responsibleSession.cookie },
    });
    expect(assigned.statusCode).toBe(200);
    const assignedBody = assigned.json() as {
      defectItems: Array<{ id: string; version: number; proposalsBC?: unknown }>;
    };
    expect(assignedBody).not.toHaveProperty('proposalsBC');
    expect(JSON.stringify(assignedBody)).not.toMatch(/proposalsBC/);

    const otherSession = await login(otherResponsible.email);
    const hidden = await inject({
      method: 'GET',
      url: `/api/acts/${firstBody.id}`,
      cookies: { [SESSION_COOKIE_NAME]: otherSession.cookie },
    });
    expect(hidden.statusCode).toBe(404);

    const defectId = assignedBody.defectItems[0]!.id;
    const completeWhileNew = await mutate(responsibleSession, {
      method: 'POST',
      url: `/api/defects/${defectId}/complete`,
      payload: { expectedVersion: assignedBody.defectItems[0]!.version, readyAt: '2026-08-20' },
    });
    expect(completeWhileNew.statusCode).toBe(409);

    const started = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${firstBody.id}/start`,
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    expect((started.json() as { status: string }).status).toBe('IN_PROGRESS');

    const completeByAssigned = await mutate(responsibleSession, {
      method: 'POST',
      url: `/api/defects/${defectId}/complete`,
      payload: { expectedVersion: assignedBody.defectItems[0]!.version, readyAt: '2026-08-20' },
    });
    expect(completeByAssigned.statusCode).toBe(409);
    await prisma.userOrganizationMembership.create({
      data: { userId: contractor.id, organizationId: liable.id, assignedByUserId: admin.id },
    });
    await assignObjectEngineers(object.id, [contractor.id]);
    expect(
      (
        await mutate(contractorSession, {
          method: 'POST',
          url: `/api/defects/${defectId}/complete`,
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(403);

    const claimAttempt = await mutate(responsibleSession, {
      method: 'PATCH',
      url: `/api/defects/${defectId}/deadlines`,
      payload: { expectedVersion: 2, claimDeadline: '2026-10-01', reason: 'нельзя' },
    });
    expect(claimAttempt.statusCode).toBe(409);

    const thirdParty = await mutate(contractorSession, {
      method: 'PATCH',
      url: `/api/defects/${defectId}/deadlines`,
      payload: { expectedVersion: 1, thirdPartyDeadline: '2026-10-01' },
    });
    expect([200, 409]).toContain(thirdParty.statusCode);

    const proposal = await mutate(adminSession, {
      method: 'PUT',
      url: `/api/defects/${defectId}/proposals/A`,
      payload: { amount: '15.50', alternativeContractorOrganizationId: alt.id },
    });
    expect(proposal.statusCode).toBe(200);
    const proposalB = await mutate(adminSession, {
      method: 'PUT',
      url: `/api/defects/${defectId}/proposals/B`,
      payload: { amount: '20.00', alternativeContractorOrganizationId: alt.id },
    });
    expect(proposalB.statusCode).toBe(200);
    expect(
      (
        await mutate(responsibleSession, {
          method: 'PUT',
          url: `/api/defects/${defectId}/proposals/A`,
          payload: { amount: '1.00', alternativeContractorOrganizationId: alt.id },
        })
      ).statusCode,
    ).toBe(403);

    const history = await inject({
      method: 'GET',
      url: `/api/acts/${firstBody.id}/history`,
      cookies: { [SESSION_COOKIE_NAME]: responsibleSession.cookie },
    });
    expect(history.statusCode).toBe(200);
    const historyBody = history.json() as { items: unknown[]; totalCount: number };
    expect(JSON.stringify(historyBody)).not.toMatch(/"slot":"B"/);
    expect(JSON.stringify(historyBody)).not.toMatch(/proposalsBC/);

    const header = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/acts/${firstBody.id}/header`,
      payload: { expectedVersion: 2, signedDocumentRef: 'док-1' },
    });
    expect(header.statusCode).toBe(200);
    const stale = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/acts/${firstBody.id}/header`,
      payload: { expectedVersion: 2, signedDocumentRef: 'stale' },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('keeps access after defect unassign and revokes it after object unassign', async () => {
    const admin = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const adminSession = await login(admin.email);
    const { object, customer, liable, defectType } = await catalogs();
    await assignObjectEngineers(object.id, [responsible.id]);
    const created = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S23',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-08-22',
        defectItems: [
          {
            location: 'Холл',
            defectTypeId: defectType.id,
            claimDetails: 'Дефект',
            responsibleEngineerIds: [responsible.id],
            liableOrganizationIds: [liable.id],
          },
        ],
      },
      headers: { 'idempotency-key': `assign-${Date.now()}` },
    });
    const actId = (created.json() as { id: string }).id;
    createdActIds.push(actId);
    const responsibleSession = await login(responsible.email);
    const detail = await inject({
      method: 'GET',
      url: `/api/acts/${actId}`,
      cookies: { [SESSION_COOKIE_NAME]: responsibleSession.cookie },
    });
    expect(detail.statusCode).toBe(200);
    const item = (detail.json() as { defectItems: Array<{ id: string; version: number }> })
      .defectItems[0]!;
    const removed = await mutate(adminSession, {
      method: 'PUT',
      url: `/api/defects/${item.id}/assignments`,
      payload: {
        expectedVersion: item.version,
        responsibleEngineerIds: [],
        liableOrganizationIds: [liable.id],
        confirmRemoveLastEngineer: true,
      },
    });
    expect(removed.statusCode).toBe(200);
    const stillVisible = await inject({
      method: 'GET',
      url: `/api/acts/${actId}`,
      cookies: { [SESSION_COOKIE_NAME]: responsibleSession.cookie },
    });
    expect(stillVisible.statusCode).toBe(200);
    const objectRow = await prisma.propertyObject.findUniqueOrThrow({ where: { id: object.id } });
    const revoked = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/reference-data/property-objects/${object.id}`,
      payload: {
        expectedVersion: objectRow.version,
        name: object.name,
        address: object.address,
        responsibleEngineerIds: [],
      },
    });
    expect(revoked.statusCode).toBe(200);
    const after = await inject({
      method: 'GET',
      url: `/api/acts/${actId}`,
      cookies: { [SESSION_COOKIE_NAME]: responsibleSession.cookie },
    });
    expect(after.statusCode).toBe(404);
  });

  it('rejects unknown, archived and spoofed proposal organizations', async () => {
    const admin = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const adminSession = await login(admin.email);
    const { object, customer, liable, alt, defectType } = await catalogs();
    await assignObjectEngineers(object.id, [responsible.id]);
    const archivedAlt = await prisma.organization.create({
      data: {
        officialName: `Архив альт ${Date.now()}`,
        postalAddress: 'addr',
        email: `arch-alt-${Date.now()}@example.sgr.local`,
        phone: '1',
        contactPerson: 'А',
        active: false,
        archivedAt: new Date(),
        roles: { create: [{ role: 'ALTERNATIVE_CONTRACTOR' }] },
      },
    });
    const created = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-08-20',
        defectItems: [
          {
            location: 'Кв. орг',
            defectTypeId: defectType.id,
            claimDetails: 'Течь',
            responsibleEngineerIds: [responsible.id],
            liableOrganizationIds: [liable.id],
          },
        ],
      },
      headers: { 'idempotency-key': `prop-org-${Date.now()}` },
    });
    expect(created.statusCode).toBe(201);
    const actId = (created.json() as { id: string }).id;
    createdActIds.push(actId);
    const detail = await inject({
      method: 'GET',
      url: `/api/acts/${actId}`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    const defectId = (detail.json() as { defectItems: Array<{ id: string }> }).defectItems[0]!.id;

    expect(
      (
        await mutate(adminSession, {
          method: 'PUT',
          url: `/api/defects/${defectId}/proposals/A`,
          payload: {
            amount: '10.00',
            alternativeContractorOrganizationId: alt.id,
            organizationName: 'ООО Подмена',
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await mutate(adminSession, {
          method: 'PUT',
          url: `/api/defects/${defectId}/proposals/A`,
          payload: {
            amount: '10.00',
            alternativeContractorOrganizationId: '00000000-0000-4000-8000-000000000099',
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await mutate(adminSession, {
          method: 'PUT',
          url: `/api/defects/${defectId}/proposals/A`,
          payload: {
            amount: '10.00',
            alternativeContractorOrganizationId: archivedAlt.id,
          },
        })
      ).statusCode,
    ).toBe(400);

    const valid = await mutate(adminSession, {
      method: 'PUT',
      url: `/api/defects/${defectId}/proposals/A`,
      payload: { amount: '15.50', alternativeContractorOrganizationId: alt.id },
    });
    expect(valid.statusCode).toBe(200);
    expect((valid.json() as { slot: string }).slot).toBe('A');

    const afterSave = await inject({
      method: 'GET',
      url: `/api/acts/${actId}`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    const proposalA = (
      afterSave.json() as {
        defectItems: Array<{
          proposalA: { amount: string; currency: string; contractorName: string };
        }>;
      }
    ).defectItems[0]!.proposalA;
    expect(proposalA).toMatchObject({
      amount: '15.50',
      currency: 'BYN',
      contractorName: alt.officialName,
    });

    const lookups = await inject({
      method: 'GET',
      url: '/api/operations/lookups',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(lookups.statusCode).toBe(200);
    const lookupIds = (
      lookups.json() as { alternativeContractors: Array<{ id: string }> }
    ).alternativeContractors.map((org) => org.id);
    expect(lookupIds).toContain(alt.id);
    expect(lookupIds).not.toContain(archivedAlt.id);
  });

  it('rejects unknown or inactive defect and work type ids', async () => {
    const admin = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const adminSession = await login(admin.email);
    const { object, customer, liable, defectType } = await catalogs();
    await assignObjectEngineers(object.id, [responsible.id]);
    const lookups = await inject({
      method: 'GET',
      url: '/api/operations/lookups',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(lookups.statusCode).toBe(200);
    const body = lookups.json() as {
      defectTypes: Array<{ id: string; name: string }>;
      workTypes: Array<{ id: string; name: string }>;
    };
    expect(body.defectTypes.some((item) => item.id === defectType.id)).toBe(true);
    expect(Array.isArray(body.workTypes)).toBe(true);
    const missingType = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-08-20',
        defectItems: [
          {
            location: 'Кв. 1',
            defectTypeId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            claimDetails: 'Течь',
            responsibleEngineerIds: [responsible.id],
            liableOrganizationIds: [liable.id],
          },
        ],
      },
    });
    expect(missingType.statusCode).toBe(400);
    const inactiveWork = await prisma.workType.create({
      data: {
        code: `OPS-WT-${Date.now()}`,
        name: `Неактивный вид ${Date.now()}`,
        sortOrder: 80,
        active: false,
      },
    });
    const inactive = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-08-20',
        defectItems: [
          {
            location: 'Кв. 1',
            defectTypeId: defectType.id,
            workTypeId: inactiveWork.id,
            claimDetails: 'Течь',
            responsibleEngineerIds: [responsible.id],
            liableOrganizationIds: [liable.id],
          },
        ],
      },
    });
    expect(inactive.statusCode).toBe(400);
  });

  it('denies contractor history reads while still recording contractor mutations', async () => {
    const admin = await createUser('ADMIN');
    const manager = await createUser('SGR_MANAGER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const foreign = await createUser('RESPONSIBLE_ENGINEER');
    const adminSession = await login(admin.email);
    const managerSession = await login(manager.email);
    const contractorSession = await login(contractor.email);
    const responsibleSession = await login(responsible.email);
    const foreignSession = await login(foreign.email);
    const { object, customer, liable, alt, defectType } = await catalogs();
    await assignObjectEngineers(object.id, [responsible.id]);
    const created = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-08-20',
        defectItems: [
          {
            location: 'Кв. история',
            defectTypeId: defectType.id,
            claimDetails: 'Течь',
            responsibleEngineerIds: [responsible.id],
            liableOrganizationIds: [liable.id],
            plannedDeadline: '2026-09-01',
          },
        ],
      },
      headers: { 'idempotency-key': `hist-${Date.now()}` },
    });
    expect(created.statusCode).toBe(201);
    const actId = (created.json() as { id: string }).id;
    createdActIds.push(actId);
    const detail = await read(adminSession, `/api/acts/${actId}`);
    const defectId = (detail.json() as { defectItems: Array<{ id: string }> }).defectItems[0]!.id;

    const proposal = await mutate(adminSession, {
      method: 'PUT',
      url: `/api/defects/${defectId}/proposals/A`,
      payload: { amount: '11.00', alternativeContractorOrganizationId: alt.id },
    });
    expect(proposal.statusCode).toBe(200);
    const proposalId = (proposal.json() as { id: string }).id;

    const afterProposal = await read(adminSession, `/api/acts/${actId}`);
    const defectVersion = (
      afterProposal.json() as { defectItems: Array<{ id: string; version: number }> }
    ).defectItems[0]!.version;
    await prisma.userOrganizationMembership.create({
      data: { userId: contractor.id, organizationId: liable.id, assignedByUserId: admin.id },
    });
    await assignObjectEngineers(object.id, [contractor.id]);
    const thirdParty = await mutate(contractorSession, {
      method: 'PATCH',
      url: `/api/defects/${defectId}/deadlines`,
      payload: { expectedVersion: defectVersion, thirdPartyDeadline: '2026-10-01' },
    });
    expect(thirdParty.statusCode).toBe(200);

    const adminHistory = await read(adminSession, `/api/acts/${actId}/history`);
    expect(adminHistory.statusCode).toBe(200);
    expect(JSON.stringify(adminHistory.json())).toContain('DEADLINE_UPDATED');

    const managerHistory = await read(managerSession, `/api/acts/${actId}/history`);
    expect(managerHistory.statusCode).toBe(200);

    const assignedHistory = await read(responsibleSession, `/api/acts/${actId}/history`);
    expect(assignedHistory.statusCode).toBe(200);
    expect(JSON.stringify(assignedHistory.json())).not.toMatch(/"slot":"B"/);

    const foreignHistory = await read(foreignSession, `/api/acts/${actId}/history`);
    expect(foreignHistory.statusCode).toBe(404);

    const forbiddenUrls = [
      `/api/acts/${actId}/history`,
      `/api/defects/${defectId}/history`,
      `/api/proposals/${proposalId}/history`,
      '/api/audit-log',
      `/api/users/${admin.id}/history`,
      `/api/acts/00000000-0000-4000-8000-000000000099/history`,
    ];
    for (const url of forbiddenUrls) {
      const response = await read(contractorSession, url);
      expect(response.statusCode).toBe(403);
      const body = JSON.stringify(response.json());
      expect(body).not.toMatch(/DEADLINE_UPDATED|actorName|totalCount|"items"/);
      expect(body).not.toContain(admin.fullName);
    }

    const defectHistory = await read(adminSession, `/api/defects/${defectId}/history`);
    expect(defectHistory.statusCode).toBe(200);
    const proposalHistory = await read(adminSession, `/api/proposals/${proposalId}/history`);
    expect(proposalHistory.statusCode).toBe(200);
  });

  it('lets a responsible engineer create an act on an assigned object and rejects a foreign objectId', async () => {
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const engineerSession = await login(engineer.email);
    const own = await catalogs();
    const foreign = await catalogs();
    await assignObjectEngineers(own.object.id, [engineer.id]);
    const created = await mutate(engineerSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: own.object.id,
        customerOrganizationId: own.customer.id,
        issuedOn: '2026-08-20',
        defectItems: [
          {
            location: 'Кв. инженера',
            defectTypeId: own.defectType.id,
            claimDetails: 'Описание',
            responsibleEngineerIds: [engineer.id],
            liableOrganizationIds: [own.liable.id],
          },
        ],
      },
      headers: { 'idempotency-key': `eng-create-${Date.now()}` },
    });
    expect(created.statusCode).toBe(201);
    const actId = (created.json() as { id: string }).id;
    createdActIds.push(actId);
    const list = await read(engineerSession, '/api/registry/defects?pageSize=200');
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain(actId);
    const lookups = await read(engineerSession, '/api/operations/lookups');
    const lookupIds = (
      lookups.json() as { propertyObjects: Array<{ id: string }> }
    ).propertyObjects.map((item) => item.id);
    expect(lookupIds).toContain(own.object.id);
    expect(lookupIds).not.toContain(foreign.object.id);
    const rejected = await mutate(engineerSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: foreign.object.id,
        customerOrganizationId: own.customer.id,
        issuedOn: '2026-08-20',
        defectItems: [
          {
            location: 'Чужой',
            defectTypeId: own.defectType.id,
            claimDetails: 'Нет',
            responsibleEngineerIds: [engineer.id],
            liableOrganizationIds: [own.liable.id],
          },
        ],
      },
      headers: { 'idempotency-key': `eng-foreign-${Date.now()}` },
    });
    expect(rejected.statusCode).toBe(404);
    expect(JSON.stringify(rejected.json())).not.toContain(foreign.object.id);
  });

  it('reactivates object engineer assignments and rejects illegal assignees', async () => {
    const admin = await createUser('ADMIN');
    const manager = await createUser('SGR_MANAGER');
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const otherEngineer = await createUser('RESPONSIBLE_ENGINEER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const archived = await createUser('RESPONSIBLE_ENGINEER', { status: 'ARCHIVED' });
    const adminSession = await login(admin.email);
    const engineerSession = await login(engineer.email);
    const { object, customer, liable, defectType } = await catalogs();
    const unknownFields = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/reference-data/property-objects/${object.id}`,
      payload: {
        expectedVersion: object.version,
        name: object.name,
        address: object.address,
        role: 'ADMIN',
        userId: admin.id,
      },
    });
    expect(unknownFields.statusCode).toBe(400);

    const forbiddenEngineerWrite = await mutate(engineerSession, {
      method: 'PATCH',
      url: `/api/reference-data/property-objects/${object.id}`,
      payload: {
        expectedVersion: object.version,
        name: object.name,
        address: object.address,
        responsibleEngineerIds: [engineer.id],
      },
    });
    expect(forbiddenEngineerWrite.statusCode).toBe(403);

    for (const illegalId of [admin.id, manager.id, contractor.id, archived.id]) {
      const rejected = await mutate(adminSession, {
        method: 'PATCH',
        url: `/api/reference-data/property-objects/${object.id}`,
        payload: {
          expectedVersion: (
            await prisma.propertyObject.findUniqueOrThrow({ where: { id: object.id } })
          ).version,
          name: object.name,
          address: object.address,
          responsibleEngineerIds: [illegalId],
        },
      });
      expect(rejected.statusCode).toBe(400);
    }

    const assigned = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/reference-data/property-objects/${object.id}`,
      payload: {
        expectedVersion: (
          await prisma.propertyObject.findUniqueOrThrow({ where: { id: object.id } })
        ).version,
        name: object.name,
        address: object.address,
        responsibleEngineerIds: [engineer.id],
      },
    });
    expect(assigned.statusCode).toBe(200);
    const firstRow = await prisma.propertyObjectEngineer.findFirstOrThrow({
      where: { propertyObjectId: object.id, userId: engineer.id },
    });
    expect(firstRow.unassignedAt).toBeNull();

    const duplicateActive = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/reference-data/property-objects/${object.id}`,
      payload: {
        expectedVersion: (assigned.json() as { version: number }).version,
        name: object.name,
        address: object.address,
        responsibleEngineerIds: [engineer.id],
      },
    });
    expect(duplicateActive.statusCode).toBe(200);
    expect(
      await prisma.propertyObjectEngineer.count({
        where: { propertyObjectId: object.id, userId: engineer.id },
      }),
    ).toBe(1);

    const created = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-08-20',
        defectItems: [
          {
            location: 'Кв. назначение',
            defectTypeId: defectType.id,
            claimDetails: 'Описание',
            responsibleEngineerIds: [engineer.id],
            liableOrganizationIds: [liable.id],
          },
        ],
      },
      headers: { 'idempotency-key': `assign-lifecycle-${Date.now()}` },
    });
    expect(created.statusCode).toBe(201);
    const actId = (created.json() as { id: string }).id;
    createdActIds.push(actId);
    expect((await read(engineerSession, `/api/acts/${actId}`)).statusCode).toBe(200);

    let objectRow = await prisma.propertyObject.findUniqueOrThrow({ where: { id: object.id } });
    const revoked = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/reference-data/property-objects/${object.id}`,
      payload: {
        expectedVersion: objectRow.version,
        name: object.name,
        address: object.address,
        responsibleEngineerIds: [],
      },
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      (
        await prisma.propertyObjectEngineer.findFirstOrThrow({
          where: { propertyObjectId: object.id, userId: engineer.id },
        })
      ).unassignedAt,
    ).not.toBeNull();
    const hidden = await read(engineerSession, `/api/acts/${actId}`);
    expect(hidden.statusCode).toBe(404);
    expect(JSON.stringify(hidden.json())).not.toContain(actId);

    objectRow = await prisma.propertyObject.findUniqueOrThrow({ where: { id: object.id } });
    const reassigned = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/reference-data/property-objects/${object.id}`,
      payload: {
        expectedVersion: objectRow.version,
        name: object.name,
        address: object.address,
        responsibleEngineerIds: [engineer.id],
      },
    });
    expect(reassigned.statusCode).toBe(200);
    const afterReassign = await prisma.propertyObjectEngineer.findMany({
      where: { propertyObjectId: object.id, userId: engineer.id },
    });
    expect(afterReassign).toHaveLength(1);
    expect(afterReassign[0]!.id).toBe(firstRow.id);
    expect(afterReassign[0]!.unassignedAt).toBeNull();
    expect((await read(engineerSession, `/api/acts/${actId}`)).statusCode).toBe(200);

    await prisma.user.update({
      where: { id: engineer.id },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    objectRow = await prisma.propertyObject.findUniqueOrThrow({ where: { id: object.id } });
    const keepArchivedAssignee = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/reference-data/property-objects/${object.id}`,
      payload: {
        expectedVersion: objectRow.version,
        name: `${object.name} обновлён`,
        address: object.address,
        responsibleEngineerIds: [engineer.id],
      },
    });
    expect(keepArchivedAssignee.statusCode).toBe(200);
    await prisma.user.update({
      where: { id: engineer.id },
      data: { status: 'ACTIVE', archivedAt: null },
    });

    objectRow = await prisma.propertyObject.findUniqueOrThrow({ where: { id: object.id } });
    const [firstConcurrent, secondConcurrent] = await Promise.all([
      mutate(adminSession, {
        method: 'PATCH',
        url: `/api/reference-data/property-objects/${object.id}`,
        payload: {
          expectedVersion: objectRow.version,
          name: `${object.name} обновлён`,
          address: object.address,
          responsibleEngineerIds: [engineer.id, otherEngineer.id],
        },
      }),
      mutate(adminSession, {
        method: 'PATCH',
        url: `/api/reference-data/property-objects/${object.id}`,
        payload: {
          expectedVersion: objectRow.version,
          name: `${object.name} обновлён`,
          address: object.address,
          responsibleEngineerIds: [engineer.id, otherEngineer.id],
        },
      }),
    ]);
    const concurrentCodes = [firstConcurrent.statusCode, secondConcurrent.statusCode].sort();
    expect(concurrentCodes).toEqual([200, 409]);
    expect(
      await prisma.propertyObjectEngineer.count({
        where: { propertyObjectId: object.id, userId: otherEngineer.id },
      }),
    ).toBe(1);

    const audit = await prisma.auditLog.findMany({
      where: {
        entityType: 'PROPERTY_OBJECT',
        entityId: object.id,
        action: 'OBJECT_ENGINEERS_REPLACED',
      },
    });
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toMatch(/password|csrf|cookie|authorization/i);

    const lookups = await read(engineerSession, '/api/operations/lookups');
    const lookupEngineers = (
      lookups.json() as { responsibleEngineers: Array<{ id: string }> }
    ).responsibleEngineers.map((item) => item.id);
    expect(lookupEngineers).toContain(engineer.id);
    expect(lookupEngineers).toContain(otherEngineer.id);
    expect(lookupEngineers).not.toContain(contractor.id);
  });

  it('lets an object engineer read history of a defect assigned to another engineer', async () => {
    const admin = await createUser('ADMIN');
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const peer = await createUser('RESPONSIBLE_ENGINEER');
    const adminSession = await login(admin.email);
    const engineerSession = await login(engineer.email);
    const { object, customer, liable, defectType } = await catalogs();
    const objectRow = await prisma.propertyObject.findUniqueOrThrow({ where: { id: object.id } });
    const assigned = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/reference-data/property-objects/${object.id}`,
      payload: {
        expectedVersion: objectRow.version,
        name: object.name,
        address: object.address,
        responsibleEngineerIds: [engineer.id, peer.id],
      },
    });
    expect(assigned.statusCode).toBe(200);
    const created = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-08-21',
        defectItems: [
          {
            location: 'Чужая строка',
            defectTypeId: defectType.id,
            claimDetails: 'Видна по объекту',
            responsibleEngineerIds: [peer.id],
            liableOrganizationIds: [liable.id],
          },
        ],
      },
      headers: { 'idempotency-key': `peer-hist-${Date.now()}` },
    });
    expect(created.statusCode).toBe(201);
    const actId = (created.json() as { id: string }).id;
    createdActIds.push(actId);
    const detail = await read(engineerSession, `/api/acts/${actId}`);
    expect(detail.statusCode).toBe(200);
    const actBody = detail.json() as {
      version: number;
      defectItems: Array<{ id: string }>;
    };
    const defectId = actBody.defectItems[0]!.id;
    const added = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${actId}/defects`,
      payload: {
        expectedActVersion: actBody.version,
        location: 'Ещё чужая строка',
        defectTypeId: defectType.id,
        claimDetails: 'Добавлена позже',
        responsibleEngineerIds: [peer.id],
        liableOrganizationIds: [liable.id],
      },
    });
    expect(added.statusCode).toBe(201);
    const addedId = (added.json() as { id: string }).id;
    const history = await read(engineerSession, `/api/acts/${actId}/history`);
    expect(history.statusCode).toBe(200);
    const body = JSON.stringify(history.json());
    expect(body).toContain('ACT_CREATED');
    expect(body).toContain('DEFECT_ADDED');
    expect(body).toContain(defectId);
    expect(body).toContain(addedId);
    expect(body).not.toMatch(/"slot":"B"|"slot":"C"|proposalsBC/);
    const defectHistory = await read(engineerSession, `/api/defects/${addedId}/history`);
    expect(defectHistory.statusCode).toBe(200);
    expect(JSON.stringify(defectHistory.json())).toContain('DEFECT_ADDED');
  });

  it('starts a new act with RBAC, CSRF, idempotency and concurrency guards', async () => {
    const admin = await createUser('ADMIN');
    const manager = await createUser('SGR_MANAGER');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const foreign = await createUser('RESPONSIBLE_ENGINEER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const superAdmin = await ensureActiveSuperAdmin();
    const adminSession = await login(admin.email);
    const managerSession = await login(manager.email);
    const responsibleSession = await login(responsible.email);
    const foreignSession = await login(foreign.email);
    const contractorSession = await login(contractor.email);
    const superAdminSession = await login(superAdmin.email);
    const { object, customer, liable, defectType } = await catalogs();
    const otherObject = await prisma.propertyObject.create({
      data: { name: `Чужой объект ${Date.now()}`, address: 'Минск' },
    });
    await assignObjectEngineers(object.id, [responsible.id]);
    await assignObjectEngineers(otherObject.id, [foreign.id]);

    const created = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-08-20',
        defectItems: [
          {
            location: 'Старт',
            defectTypeId: defectType.id,
            claimDetails: 'Новый акт',
            responsibleEngineerIds: [responsible.id],
            liableOrganizationIds: [liable.id],
          },
        ],
      },
      headers: { 'idempotency-key': `start-${Date.now()}` },
    });
    expect(created.statusCode).toBe(201);
    const actId = (created.json() as { id: string }).id;
    createdActIds.push(actId);

    expect((await read(adminSession, `/api/acts/${actId}`)).json()).toMatchObject({
      status: 'NEW',
    });
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: `/api/acts/${actId}/start`,
          payload: { startedAt: '2026-01-01T00:00:00.000Z' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await inject({
          method: 'POST',
          url: `/api/acts/${actId}/start`,
          payload: {},
          cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(contractorSession, {
          method: 'POST',
          url: `/api/acts/${actId}/start`,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(foreignSession, {
          method: 'POST',
          url: `/api/acts/${actId}/start`,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: '/api/acts/not-a-uuid/start',
          payload: {},
        })
      ).statusCode,
    ).toBe(404);

    const [first, second] = await Promise.all([
      mutate(adminSession, { method: 'POST', url: `/api/acts/${actId}/start`, payload: {} }),
      mutate(managerSession, { method: 'POST', url: `/api/acts/${actId}/start`, payload: {} }),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const stored = await prisma.act.findUniqueOrThrow({ where: { id: actId } });
    expect(stored.status).toBe('IN_PROGRESS');
    expect(stored.startedAt).toBeTruthy();
    expect([admin.id, manager.id]).toContain(stored.startedById);
    const firstStarterId = stored.startedById;
    const startedLogs = await prisma.auditLog.findMany({
      where: { entityId: actId, action: 'ACT_STARTED' },
    });
    expect(startedLogs).toHaveLength(1);

    const repeat = await mutate(responsibleSession, {
      method: 'POST',
      url: `/api/acts/${actId}/start`,
      payload: {},
    });
    expect(repeat.statusCode).toBe(200);
    expect((repeat.json() as { startedBy: { id: string } }).startedBy.id).toBe(firstStarterId);
    const superRepeat = await mutate(superAdminSession, {
      method: 'POST',
      url: `/api/acts/${actId}/start`,
      payload: {},
    });
    expect(superRepeat.statusCode).toBe(200);
    expect((superRepeat.json() as { startedBy: { id: string } }).startedBy.id).toBe(firstStarterId);
    expect(await prisma.auditLog.count({ where: { entityId: actId, action: 'ACT_STARTED' } })).toBe(
      1,
    );

    const completedAct = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-08-21',
        defectItems: [
          {
            location: 'Исполнение',
            defectTypeId: defectType.id,
            claimDetails: 'Один дефект',
            responsibleEngineerIds: [responsible.id],
            liableOrganizationIds: [],
          },
        ],
      },
      headers: { 'idempotency-key': `start-complete-${Date.now()}` },
    });
    const completedActId = (completedAct.json() as { id: string }).id;
    createdActIds.push(completedActId);
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: `/api/acts/${completedActId}/start`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const detail = await read(adminSession, `/api/acts/${completedActId}`);
    const defect = (detail.json() as { defectItems: Array<{ id: string; version: number }> })
      .defectItems[0]!;
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: `/api/defects/${defect.id}/complete`,
          payload: { expectedVersion: defect.version },
        })
      ).statusCode,
    ).toBe(200);
    expect((await prisma.act.findUniqueOrThrow({ where: { id: completedActId } })).status).toBe(
      'COMPLETED',
    );
    const afterComplete = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${completedActId}/start`,
      payload: {},
    });
    expect(afterComplete.statusCode).toBe(200);
    expect((afterComplete.json() as { status: string }).status).toBe('COMPLETED');
    expect(
      await prisma.auditLog.count({ where: { entityId: completedActId, action: 'ACT_STARTED' } }),
    ).toBe(1);
  });

  it('cancels an in-progress act once and refuses a completed act', async () => {
    const admin = await createUser('ADMIN');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const superAdmin = await ensureActiveSuperAdmin();
    const { object, customer, liable, defectType } = await catalogs();
    await assignObjectEngineers(object.id, [responsible.id]);
    const adminSession = await login(admin.email);
    const contractorSession = await login(contractor.email);
    const superSession = await login(superAdmin.email);
    const created = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-08-22',
        defectItems: [
          {
            location: 'Аннулирование',
            defectTypeId: defectType.id,
            claimDetails: 'Ошибочная строка',
            responsibleEngineerIds: [responsible.id],
            liableOrganizationIds: [liable.id],
          },
        ],
      },
      headers: { 'idempotency-key': `cancel-${Date.now()}` },
    });
    expect(created.statusCode).toBe(201);
    const actId = (created.json() as { id: string }).id;
    createdActIds.push(actId);
    const started = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${actId}/start`,
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    const version = (started.json() as { version: number }).version;
    expect(
      (
        await mutate(contractorSession, {
          method: 'POST',
          url: `/api/acts/${actId}/cancel`,
          payload: { expectedVersion: version, reason: 'не моя операция' },
        })
      ).statusCode,
    ).toBe(403);
    const cancelled = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${actId}/cancel`,
      payload: { expectedVersion: version, reason: 'ошибочно создан' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { status: string }).status).toBe('CANCELLED');
    const repeat = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${actId}/cancel`,
      payload: { expectedVersion: version + 1, reason: 'повтор' },
    });
    expect(repeat.statusCode).toBe(200);
    const superRepeat = await mutate(superSession, {
      method: 'POST',
      url: `/api/acts/${actId}/cancel`,
      payload: { expectedVersion: version + 1, reason: 'надзор' },
    });
    expect(superRepeat.statusCode).toBe(200);
    expect(
      await prisma.auditLog.count({ where: { entityId: actId, action: 'ACT_CANCELLED' } }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { type: 'ACT_CANCELLED', payload: { path: ['actId'], equals: actId } },
      }),
    ).toBe(1);
    await prisma.outboxEvent.deleteMany({
      where: { type: 'ACT_CANCELLED', payload: { path: ['actId'], equals: actId } },
    });
    const stored = await prisma.act.findUniqueOrThrow({ where: { id: actId } });
    expect(stored.cancellationReason).toBe('ошибочно создан');
    expect(await prisma.defectItem.count({ where: { actId } })).toBe(1);
    const completed = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-08-23',
        defectItems: [
          {
            location: 'Завершение',
            defectTypeId: defectType.id,
            claimDetails: 'Строка',
            responsibleEngineerIds: [responsible.id],
            liableOrganizationIds: [],
          },
        ],
      },
      headers: { 'idempotency-key': `cancel-done-${Date.now()}` },
    });
    const completedId = (completed.json() as { id: string }).id;
    createdActIds.push(completedId);
    await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${completedId}/start`,
      payload: {},
    });
    const detail = await read(adminSession, `/api/acts/${completedId}`);
    const defect = (detail.json() as { defectItems: Array<{ id: string; version: number }> })
      .defectItems[0]!;
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: `/api/defects/${defect.id}/complete`,
          payload: { expectedVersion: defect.version },
        })
      ).statusCode,
    ).toBe(200);
    const completedAct = await prisma.act.findUniqueOrThrow({ where: { id: completedId } });
    const refused = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${completedId}/cancel`,
      payload: { expectedVersion: completedAct.version, reason: 'после исполнения' },
    });
    expect(refused.statusCode).toBe(409);
    expect((await prisma.act.findUniqueOrThrow({ where: { id: completedId } })).status).toBe(
      'COMPLETED',
    );
  });

  it('stores an empty draft and rejects only invalid entered values', async () => {
    const admin = await createUser('ADMIN');
    const outsider = await createUser('RESPONSIBLE_ENGINEER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const adminSession = await login(admin.email);
    const created = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: { defectItems: [{ location: '   ', claimDetails: '  ' }] },
      headers: { 'idempotency-key': `empty-draft-${Date.now()}` },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json() as { id: string; version: number };
    createdActIds.push(draft.id);
    const stored = await prisma.act.findUniqueOrThrow({
      where: { id: draft.id },
      include: { defectItems: true },
    });
    expect(stored.status).toBe('NEW');
    expect(stored.objectId).toBeNull();
    expect(stored.customerOrganizationId).toBeNull();
    expect(stored.issuedOn).toBeNull();
    expect(stored.formCode).toBeNull();
    expect(stored.createdById).toBe(admin.id);
    expect(stored.defectItems).toHaveLength(0);
    expect(await prisma.slaClock.count({ where: { defectItem: { actId: draft.id } } })).toBe(0);
    expect((await read(await login(outsider.email), `/api/acts/${draft.id}`)).statusCode).toBe(404);
    expect((await read(await login(contractor.email), `/api/acts/${draft.id}`)).statusCode).toBe(
      404,
    );

    const invalidDate = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/acts/${draft.id}/header`,
      payload: { expectedVersion: draft.version, issuedOn: '2026-02-31' },
    });
    expect(invalidDate.statusCode).toBe(400);

    const partial = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${draft.id}/defects`,
      payload: {
        expectedActVersion: draft.version,
        location: 'Кухня',
        responsibleEngineerId: engineer.id,
      },
    });
    expect(partial.statusCode).toBe(201);
    const defect = await prisma.defectItem.findFirstOrThrow({
      where: { actId: draft.id },
      include: { responsibleEngineers: true },
    });
    expect(defect.defectTypeId).toBeNull();
    expect(defect.claimDetails).toBeNull();
    expect(defect.responsibleEngineers.map((row) => row.userId)).toEqual([engineer.id]);
    expect(await prisma.slaClock.count({ where: { defectItemId: defect.id } })).toBe(0);

    const blocked = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${draft.id}/start`,
      payload: {},
    });
    expect(blocked.statusCode).toBe(400);
    expect((await prisma.act.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('NEW');

    const conflict = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/acts/${draft.id}/header`,
      payload: { expectedVersion: draft.version + 9, issuedOn: '2026-10-16' },
    });
    expect(conflict.statusCode).toBe(409);
    expect((await prisma.act.findUniqueOrThrow({ where: { id: draft.id } })).issuedOn).toBeNull();
  });

  it('lists an empty NEW act and separates informational and active deadlines', async () => {
    const admin = await createUser('ADMIN');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const adminSession = await login(admin.email);
    const contractorSession = await login(contractor.email);
    const { object, customer, defectType } = await catalogs();
    const empty = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: { defectItems: [] },
      headers: { 'idempotency-key': `empty-${Date.now()}` },
    });
    expect(empty.statusCode).toBe(201);
    const emptyBody = empty.json() as { id: string };
    createdActIds.push(emptyBody.id);
    const stored = await prisma.act.findUniqueOrThrow({ where: { id: emptyBody.id } });
    expect(stored.status).toBe('NEW');
    expect(stored.status).not.toBeNull();
    expect(await prisma.defectItem.count({ where: { actId: emptyBody.id } })).toBe(0);

    const filters = await read(adminSession, '/api/registry/filter-options');
    expect(filters.statusCode).toBe(200);
    const filterBody = filters.json() as { statuses: Array<{ id: string; label: string }> };
    expect(filterBody.statuses.find((item) => item.id === 'NEW')?.label).toBe(
      'Статус не установлен',
    );
    expect(JSON.stringify(filterBody.statuses)).not.toMatch(/SLA/);

    const summary = await read(adminSession, '/api/registry/summary?statuses=NEW');
    expect(summary.statusCode).toBe(200);
    const summaryBody = summary.json() as {
      total: number;
      newCount: number;
      unfinishedDrafts: Array<{ id: string; label: string }>;
    };
    expect(summaryBody.unfinishedDrafts.some((item) => item.id === emptyBody.id)).toBe(true);
    expect(summaryBody.unfinishedDrafts.find((item) => item.id === emptyBody.id)?.label).toBe(
      'Без номера',
    );
    expect(summaryBody.total).toBeGreaterThan(0);
    expect(summaryBody.newCount).toBeGreaterThan(0);
    let visible = false;
    let page = 1;
    for (;;) {
      const listed = await read(
        adminSession,
        `/api/registry/defects?statuses=NEW&pageSize=200&page=${page}`,
      );
      expect(listed.statusCode).toBe(200);
      const body = listed.json() as {
        items: Array<{ actId: string; actStatusLabel: string; actNumber: string }>;
        totalPages: number;
      };
      const row = body.items.find((item) => item.actId === emptyBody.id);
      if (row) {
        visible = true;
        expect(row.actStatusLabel).toBe('Статус не установлен');
        expect(row.actNumber).toBe('Без номера');
      }
      page += 1;
      if (visible || page > body.totalPages || page > 40) {
        break;
      }
    }
    expect(visible).toBe(true);
    expect((await read(contractorSession, `/api/acts/${emptyBody.id}`)).statusCode).toBe(404);

    const today = calendarDateInTimeZone(new Date());
    const futureDeadline = addCalendarDays(today, 5);
    const pastDeadline = addCalendarDays(today, -10);
    const dated = await mutate(adminSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-10-16',
        defectItems: [
          {
            location: 'Срок до старта',
            defectTypeId: defectType.id,
            claimDetails: 'Информационный срок',
            plannedDeadline: futureDeadline,
          },
        ],
      },
      headers: { 'idempotency-key': `dated-${Date.now()}` },
    });
    expect(dated.statusCode).toBe(201);
    const datedBody = dated.json() as { id: string };
    createdActIds.push(datedBody.id);
    const before = await read(adminSession, `/api/acts/${datedBody.id}`);
    const beforeAct = before.json() as {
      status: string;
      statusLabel: string;
      defectItems: Array<{
        id: string;
        version: number;
        plannedDeadline: string | null;
        daysRemaining: number | null;
        deadlineNotice: string | null;
        deadlineControlActive: boolean;
        deadlineState: string;
      }>;
    };
    expect(beforeAct.status).toBe('NEW');
    expect(beforeAct.statusLabel).toBe('Статус не установлен');
    expect(beforeAct.defectItems[0]?.plannedDeadline).toBe(futureDeadline);
    expect(beforeAct.defectItems[0]?.deadlineControlActive).toBe(false);
    expect(beforeAct.defectItems[0]?.deadlineState).not.toBe('OVERDUE');
    expect(beforeAct.defectItems[0]?.deadlineNotice).toBe('Контроль сроков ещё не запущен');
    expect(beforeAct.defectItems[0]?.daysRemaining).toBeGreaterThan(0);
    expect(JSON.stringify(beforeAct)).not.toMatch(/\bSLA\b/);

    const changed = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/defects/${beforeAct.defectItems[0]!.id}/deadlines`,
      payload: {
        expectedVersion: beforeAct.defectItems[0]!.version,
        plannedDeadline: pastDeadline,
        reason: 'Срок указан раньше',
      },
    });
    expect(changed.statusCode).toBe(200);
    const past = await read(adminSession, `/api/acts/${datedBody.id}`);
    const pastAct = past.json() as {
      defectItems: Array<{
        version: number;
        plannedDeadline: string | null;
        deadlineNotice: string | null;
        deadlineState: string;
        deadlineControlActive: boolean;
      }>;
    };
    expect(pastAct.defectItems[0]?.plannedDeadline).toBe(pastDeadline);
    expect(pastAct.defectItems[0]?.deadlineNotice).toContain('Контроль сроков ещё не запущен');
    expect(pastAct.defectItems[0]?.deadlineState).not.toBe('OVERDUE');
    expect(await prisma.slaClock.count({ where: { defectItem: { actId: datedBody.id } } })).toBe(0);
    const deadlineAudit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: beforeAct.defectItems[0]!.id, action: 'DEADLINE_UPDATED' },
    });
    expect(JSON.stringify(deadlineAudit.oldValue)).toContain(futureDeadline);
    expect(JSON.stringify(deadlineAudit.newValue)).toContain(pastDeadline);

    const superAdmin = await ensureActiveSuperAdmin();
    const superSession = await login(superAdmin.email);
    expect((await read(superSession, `/api/acts/${emptyBody.id}`)).statusCode).toBe(200);

    const [firstStart, secondStart] = await Promise.all([
      mutate(adminSession, {
        method: 'POST',
        url: `/api/acts/${datedBody.id}/start`,
        payload: {},
      }),
      mutate(adminSession, {
        method: 'POST',
        url: `/api/acts/${datedBody.id}/start`,
        payload: {},
      }),
    ]);
    expect([firstStart.statusCode, secondStart.statusCode].sort()).toEqual([200, 200]);
    const afterStart = await prisma.defectItem.findFirstOrThrow({
      where: { actId: datedBody.id },
    });
    expect(afterStart.plannedDeadline?.toISOString().slice(0, 10)).toBe(pastDeadline);
    const startedAct = await prisma.act.findUniqueOrThrow({ where: { id: datedBody.id } });
    expect(startedAct.status).toBe('IN_PROGRESS');
    expect(startedAct.startedAt).not.toBeNull();
    const detail = await read(adminSession, `/api/acts/${datedBody.id}`);
    const detailBody = detail.json() as {
      defectItems: Array<{ deadlineState: string; deadlineControlActive: boolean }>;
    };
    expect(detailBody.defectItems[0]?.deadlineControlActive).toBe(true);
    expect(detailBody.defectItems[0]?.deadlineState).toBe('OVERDUE');
    const slaEvents = await prisma.outboxEvent.findMany({
      where: { type: { in: ['SLA_OVERDUE', 'SLA_DUE_TODAY', 'SLA_WARNING'] } },
      select: { payload: true },
    });
    const forDefect = slaEvents.filter((event) => {
      const payload = event.payload as { defectItemId?: string } | null;
      return payload?.defectItemId === afterStart.id;
    });
    expect(forDefect).toHaveLength(1);
  });
});
