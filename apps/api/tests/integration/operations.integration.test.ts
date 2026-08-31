import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from '@sgr-registry/config';
import {
  createPrismaClient,
  disconnectPrismaClient,
  type PrismaClient,
} from '@sgr-registry/database';
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from '@sgr-registry/domain';
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
      fullName: `Операции ${role}`,
      email,
      role,
      status: extras.status ?? 'ACTIVE',
      passwordHash,
      mustChangePassword: extras.mustChangePassword ?? false,
      archivedAt: extras.status === 'ARCHIVED' ? new Date() : null,
    },
  });
  createdUserIds.push(user.id);
  return user;
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

describe('operations integration', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.REDIS_KEY_PREFIX = 'sgr-test';
    const config = loadConfig();
    prisma = createPrismaClient(config.DATABASE_URL);
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
        fullName: 'Новый Инженер',
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
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: createdBody.user.id } });
    expect(stored.passwordHash).not.toBe(createdBody.temporaryPassword);
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
    const objects = await read(responsibleSession, '/api/reference-data/property-objects');
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
    const completeByAssigned = await mutate(responsibleSession, {
      method: 'POST',
      url: `/api/defects/${defectId}/complete`,
      payload: { expectedVersion: assignedBody.defectItems[0]!.version, readyAt: '2026-08-20' },
    });
    expect(completeByAssigned.statusCode).toBe(200);
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
    expect([403, 409]).toContain(claimAttempt.statusCode);

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
      payload: { expectedVersion: 1, signedDocumentRef: 'док-1' },
    });
    expect(header.statusCode).toBe(200);
    const stale = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/acts/${firstBody.id}/header`,
      payload: { expectedVersion: 1, signedDocumentRef: 'stale' },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('grants and revokes responsible access through assignments', async () => {
    const admin = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const adminSession = await login(admin.email);
    const { object, customer, liable, defectType } = await catalogs();
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
});
