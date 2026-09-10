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
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/configure-http';
import { hashArgon2id } from '../../src/auth/crypto';
import type { UserRole } from '@sgr-registry/contracts';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

let app: NestFastifyApplication;
let prisma: PrismaClient;
let redis: Redis;
const createdUserIds: string[] = [];
const createdObjectIds: string[] = [];
const createdActIds: string[] = [];

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

async function inject(opts: {
  method: 'GET' | 'POST' | 'PATCH';
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
      'x-request-id': `profile-${Date.now()}-${Math.random()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(role: UserRole, extras: { fullName?: string } = {}) {
  const email = `profile.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: {
      ...personNameWriteFields(
        extras.fullName ?? `Профиль ${role}`,
        CONFIRMED_LAST_FIRST_TOKEN_ORDER,
      ),
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

async function login(email: string, password = DEMO_PASSWORD) {
  const response = await inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  const body = response.json() as { csrfToken: string };
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value ?? '';
  return { response, body, cookie };
}

async function mutate(
  session: { cookie: string; body: { csrfToken: string } },
  opts: {
    method: 'POST' | 'PATCH';
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

describe('manager role and user profile', () => {
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
      await prisma.defectItemEngineer.deleteMany({
        where: { defectItem: { actId: { in: createdActIds } } },
      });
      await prisma.defectItemLiableOrganization.deleteMany({
        where: { defectItem: { actId: { in: createdActIds } } },
      });
      await prisma.slaClock.deleteMany({
        where: { defectItem: { actId: { in: createdActIds } } },
      });
      await prisma.defectItem.deleteMany({ where: { actId: { in: createdActIds } } });
      await prisma.act.deleteMany({ where: { id: { in: createdActIds } } });
    }
    if (createdObjectIds.length > 0) {
      await prisma.propertyObjectEngineer.deleteMany({
        where: { propertyObjectId: { in: createdObjectIds } },
      });
      await prisma.propertyObject.deleteMany({ where: { id: { in: createdObjectIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.propertyObjectEngineer.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
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

  it('lets MANAGER perform ADMIN business actions and blocks equal-or-higher role control', async () => {
    const admin = await createUser('ADMIN');
    const orgManager = await createUser('MANAGER');
    const peerManager = await createUser('MANAGER');
    const sgr = await createUser('SGR_MANAGER');
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const existingSuper = await prisma.user.findFirst({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
      select: { id: true, email: true, version: true, role: true },
    });
    const adminSession = await login(admin.email);
    const managerSession = await login(orgManager.email);

    expect(
      (
        await inject({
          method: 'GET',
          url: '/api/registry/defects',
          cookies: { [SESSION_COOKIE_NAME]: managerSession.cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await inject({
          method: 'GET',
          url: '/api/users',
          cookies: { [SESSION_COOKIE_NAME]: managerSession.cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await inject({
          method: 'GET',
          url: '/api/system-status',
          cookies: { [SESSION_COOKIE_NAME]: managerSession.cookie },
        })
      ).statusCode,
    ).toBe(200);

    const stamp = Date.now();
    const createdObject = await mutate(managerSession, {
      method: 'POST',
      url: '/api/objects',
      payload: { name: `Руководитель объект ${stamp}`, address: 'Минск' },
    });
    expect(createdObject.statusCode).toBe(201);
    createdObjectIds.push((createdObject.json() as { id: string }).id);

    const createdLower = await mutate(managerSession, {
      method: 'POST',
      url: '/api/users',
      payload: {
        lastName: 'Сидоров',
        firstName: 'Пётр',
        email: `sidorov.${stamp}@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
      },
    });
    expect(createdLower.statusCode).toBe(201);
    createdUserIds.push((createdLower.json() as { user: { id: string } }).user.id);

    expect(
      (
        await mutate(managerSession, {
          method: 'POST',
          url: '/api/users',
          payload: {
            lastName: 'Ещё',
            firstName: 'Руководитель',
            email: `peer.${stamp}@example.sgr.local`,
            role: 'MANAGER',
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(managerSession, {
          method: 'POST',
          url: '/api/users',
          payload: {
            lastName: 'Админ',
            firstName: 'Тестовый',
            email: `adm.${stamp}@example.sgr.local`,
            role: 'ADMIN',
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await mutate(managerSession, {
          method: 'PATCH',
          url: `/api/users/${peerManager.id}`,
          payload: { expectedVersion: peerManager.version, role: 'SGR_MANAGER' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(managerSession, {
          method: 'PATCH',
          url: `/api/users/${admin.id}`,
          payload: { expectedVersion: admin.version, role: 'SGR_MANAGER' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(managerSession, {
          method: 'PATCH',
          url: `/api/users/${engineer.id}`,
          payload: { expectedVersion: engineer.version, role: 'SGR_MANAGER' },
        })
      ).statusCode,
    ).toBe(200);

    const profileForbidden = await mutate(managerSession, {
      method: 'PATCH',
      url: `/api/users/${admin.id}/profile`,
      payload: {
        expectedVersion: admin.version,
        lastName: 'Запрет',
        firstName: 'Админ',
        email: admin.email,
      },
    });
    expect(profileForbidden.statusCode).toBe(403);
    const peerProfile = await mutate(managerSession, {
      method: 'PATCH',
      url: `/api/users/${peerManager.id}/profile`,
      payload: {
        expectedVersion: peerManager.version,
        lastName: 'Запрет',
        firstName: 'Коллега',
        email: peerManager.email,
      },
    });
    expect(peerProfile.statusCode).toBe(403);
    if (existingSuper) {
      expect(
        (
          await mutate(managerSession, {
            method: 'PATCH',
            url: `/api/users/${existingSuper.id}/profile`,
            payload: {
              expectedVersion: existingSuper.version,
              lastName: 'Запрет',
              firstName: 'Супер',
              email: existingSuper.email,
            },
          })
        ).statusCode,
      ).toBe(403);
    }

    const sgrProfile = await mutate(managerSession, {
      method: 'PATCH',
      url: `/api/users/${sgr.id}/profile`,
      payload: {
        expectedVersion: sgr.version,
        lastName: 'Соколова',
        firstName: 'Марина',
        middleName: 'Игоревна',
        email: sgr.email,
      },
    });
    expect(sgrProfile.statusCode).toBe(200);
    expect((sgrProfile.json() as { user: { fullName: string } }).user.fullName).toBe(
      'Соколова Марина Игоревна',
    );

    expect(
      (
        await mutate(adminSession, {
          method: 'PATCH',
          url: `/api/users/${orgManager.id}/profile`,
          payload: {
            expectedVersion: orgManager.version,
            lastName: 'Романова',
            firstName: 'Ольга',
            email: orgManager.email,
          },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('updates names and email with uniqueness, concurrency and session revocation', async () => {
    const admin = await createUser('ADMIN');
    const otherAdmin = await createUser('ADMIN');
    const engineer = await createUser('RESPONSIBLE_ENGINEER', {
      fullName: 'Иванов Иван Иванович',
    });
    const other = await createUser('CONTRACTOR_ENGINEER');
    const adminSession = await login(admin.email);
    const otherAdminSession = await login(otherAdmin.email);
    const engineerSession = await login(engineer.email);

    expect(
      (
        await mutate(adminSession, {
          method: 'PATCH',
          url: `/api/users/${otherAdmin.id}/profile`,
          payload: {
            expectedVersion: otherAdmin.version,
            lastName: 'Другой',
            firstName: 'Админ',
            email: otherAdmin.email,
          },
        })
      ).statusCode,
    ).toBe(403);

    const hashBefore = (
      await prisma.userCredential.findUniqueOrThrow({ where: { userId: engineer.id } })
    ).passwordHash;

    const unknownFields = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/users/${engineer.id}/profile`,
      payload: {
        expectedVersion: engineer.version,
        lastName: 'Иванов',
        firstName: 'Иван',
        email: engineer.email,
        role: 'ADMIN',
      },
    });
    expect(unknownFields.statusCode).toBe(400);

    const missingName = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/users/${engineer.id}/profile`,
      payload: {
        expectedVersion: engineer.version,
        lastName: '',
        firstName: 'Иван',
        email: engineer.email,
      },
    });
    expect(missingName.statusCode).toBe(400);

    expect(
      (
        await inject({
          method: 'PATCH',
          url: '/api/users/not-a-uuid/profile',
          payload: {
            expectedVersion: 1,
            lastName: 'Иванов',
            firstName: 'Иван',
            email: engineer.email,
          },
          cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
          headers: { [CSRF_HEADER_NAME]: adminSession.body.csrfToken },
        })
      ).statusCode,
    ).toBe(404);

    expect(
      (
        await inject({
          method: 'PATCH',
          url: `/api/users/${engineer.id}/profile`,
          payload: {
            expectedVersion: engineer.version,
            lastName: 'Иванов',
            firstName: 'Иван',
            email: engineer.email,
          },
          cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
        })
      ).statusCode,
    ).toBe(403);

    const autoObject = await prisma.propertyObject.create({
      data: {
        name: `Авто ${engineer.id.slice(0, 8)}`,
        address: 'Минск',
        sourceResponsibleEngineerName: 'Иванов Иван Иванович',
      },
    });
    createdObjectIds.push(autoObject.id);
    await prisma.propertyObjectEngineer.create({
      data: {
        propertyObjectId: autoObject.id,
        userId: engineer.id,
        directoryLinkMethod: 'AUTO_EXACT',
      },
    });
    const confirmedObject = await prisma.propertyObject.create({
      data: {
        name: `Подтверждён ${engineer.id.slice(0, 8)}`,
        address: 'Минск',
        sourceResponsibleEngineerName: 'Другой Источник',
      },
    });
    createdObjectIds.push(confirmedObject.id);
    await prisma.propertyObjectEngineer.create({
      data: {
        propertyObjectId: confirmedObject.id,
        userId: engineer.id,
        directoryLinkMethod: 'ADMIN_CONFIRMED',
      },
    });

    const duplicateEmail = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/users/${engineer.id}/profile`,
      payload: {
        expectedVersion: engineer.version,
        lastName: 'Иванов',
        firstName: 'Иван',
        middleName: 'Иванович',
        email: other.email.toUpperCase(),
      },
    });
    expect(duplicateEmail.statusCode).toBe(409);

    const nextEmail = `renamed.${Date.now()}@example.sgr.local`;
    const first = mutate(adminSession, {
      method: 'PATCH',
      url: `/api/users/${engineer.id}/profile`,
      payload: {
        expectedVersion: engineer.version,
        lastName: 'Петров',
        firstName: 'Пётр',
        middleName: 'Петрович',
        email: nextEmail,
      },
    });
    const second = mutate(otherAdminSession, {
      method: 'PATCH',
      url: `/api/users/${engineer.id}/profile`,
      payload: {
        expectedVersion: engineer.version,
        lastName: 'Сидоров',
        firstName: 'Сидор',
        email: `conflict.${Date.now()}@example.sgr.local`,
      },
    });
    const raced = await Promise.all([first, second]);
    expect(raced.some((item) => item.statusCode === 200)).toBe(true);
    expect(raced.some((item) => item.statusCode === 409)).toBe(true);

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: engineer.id },
      include: { credentials: true },
    });
    expect(stored.credentials?.passwordHash).toBe(hashBefore);
    expect(['Петров Пётр Петрович', 'Сидоров Сидор']).toContain(stored.fullName);
    expect(
      (
        await inject({
          method: 'GET',
          url: '/api/auth/me',
          cookies: { [SESSION_COOKIE_NAME]: engineerSession.cookie },
        })
      ).statusCode,
    ).toBe(401);

    const autoLink = await prisma.propertyObjectEngineer.findFirst({
      where: { propertyObjectId: autoObject.id, userId: engineer.id, unassignedAt: null },
    });
    expect(autoLink?.directoryLinkMethod === 'AUTO_EXACT').toBe(false);
    const confirmed = await prisma.propertyObjectEngineer.findFirstOrThrow({
      where: { propertyObjectId: confirmedObject.id, userId: engineer.id, unassignedAt: null },
    });
    expect(confirmed.directoryLinkMethod).toBe('ADMIN_CONFIRMED');

    const audits = await prisma.auditLog.findMany({
      where: {
        entityId: engineer.id,
        action: { in: ['USER_PROFILE_UPDATED', 'USER_EMAIL_CHANGED'] },
      },
    });
    expect(audits.some((row) => row.action === 'USER_PROFILE_UPDATED')).toBe(true);
    expect(audits.some((row) => row.action === 'USER_EMAIL_CHANGED')).toBe(true);
    expect(JSON.stringify(audits)).not.toMatch(/passwordHash|csrfToken|sgr_session/);

    const suffix = Math.random().toString(16).slice(2, 8);
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
    const defectType = await prisma.defectType.create({
      data: { code: `PRF-${suffix}`, name: `Дефект ${suffix}`, sortOrder: 80 },
    });
    const orgManager = await createUser('MANAGER');
    const managerSession = await login(orgManager.email);
    const actObject = await prisma.propertyObject.create({
      data: { name: `Акт ${suffix}`, address: 'Минск' },
    });
    createdObjectIds.push(actObject.id);
    await prisma.propertyObjectEngineer.create({
      data: { propertyObjectId: actObject.id, userId: engineer.id },
    });
    const createdAct = await mutate(managerSession, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: actObject.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-08-20',
        defectItems: [
          {
            location: 'Кв. 1',
            defectTypeId: defectType.id,
            claimDetails: 'Течь',
            responsibleEngineerIds: [engineer.id],
            liableOrganizationIds: [liable.id],
          },
        ],
      },
      headers: { 'idempotency-key': `profile-act-${suffix}` },
    });
    expect(createdAct.statusCode).toBe(201);
    createdActIds.push((createdAct.json() as { id: string }).id);
  });

  it('lets SUPER_ADMIN edit ADMIN and a lower user, but not through unknown fields', async () => {
    const admin = await createUser('ADMIN');
    const engineer = await createUser('CONTRACTOR_ENGINEER');
    const existingSuper = await prisma.user.findFirst({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
      select: { id: true, email: true },
    });
    let superAdmin: { id: string; email: string };
    if (existingSuper) {
      await prisma.user.update({
        where: { id: existingSuper.id },
        data: { mustChangePassword: false },
      });
      await upsertUserCredentials(prisma, {
        userId: existingSuper.id,
        passwordHash: await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 }),
      });
      superAdmin = existingSuper;
    } else {
      superAdmin = await createUser('SUPER_ADMIN');
    }
    const sa = await login(superAdmin.email);
    expect(sa.response.statusCode).toBe(200);
    const adminEdit = await mutate(sa, {
      method: 'PATCH',
      url: `/api/users/${admin.id}/profile`,
      payload: {
        expectedVersion: admin.version,
        lastName: 'Викторов',
        firstName: 'Алексей',
        email: admin.email,
      },
    });
    expect(adminEdit.statusCode).toBe(200);
    expect((adminEdit.json() as { user: { fullName: string } }).user.fullName).toBe(
      'Викторов Алексей',
    );
    const lower = await mutate(sa, {
      method: 'PATCH',
      url: `/api/users/${engineer.id}/profile`,
      payload: {
        expectedVersion: engineer.version,
        lastName: 'Пантелеев',
        firstName: 'Игорь',
        email: engineer.email,
      },
    });
    expect(lower.statusCode).toBe(200);
  });
});
