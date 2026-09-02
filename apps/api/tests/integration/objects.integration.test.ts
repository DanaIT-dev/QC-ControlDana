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
const createdObjectIds: string[] = [];

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

async function inject(opts: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
      'x-request-id': `obj-${Date.now()}-${Math.random()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(role: UserRole) {
  const email = `objects.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: {
      fullName: `Objects ${role}`,
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
  return { cookie, csrfToken: body.csrfToken };
}

describe('objects directory API', () => {
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
    await prisma.propertyObjectEngineer.deleteMany({
      where: {
        OR: [{ propertyObjectId: { in: createdObjectIds } }, { userId: { in: createdUserIds } }],
      },
    });
    await prisma.propertyObject.deleteMany({ where: { id: { in: createdObjectIds } } });
    if (createdUserIds.length > 0) {
      await prisma.idempotencyRecord.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only',
      );
      try {
        await prisma.auditLog.deleteMany({
          where: {
            OR: [
              { actorUserId: { in: createdUserIds } },
              ...(createdObjectIds.length > 0 ? [{ entityId: { in: createdObjectIds } }] : []),
            ],
          },
        });
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
    await app?.close();
    await redis?.quit();
    await prisma?.$disconnect();
    await disconnectPrismaClient();
  });

  it('scopes list access by role, paginates, and hides import keys', async () => {
    const admin = await createUser('ADMIN');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const assigned = await prisma.propertyObject.create({
      data: {
        name: `Objects assigned ${Date.now()}`,
        address: 'ул. Назначенная, 1',
        sortOrder: 10,
        sourceResponsibleEngineerName: 'Василевич М.В.',
      },
    });
    const hidden = await prisma.propertyObject.create({
      data: {
        name: `Objects hidden ${Date.now()}`,
        address: 'ул. Чужая, 2',
        sortOrder: 20,
        sourceResponsibleEngineerName: 'Богданович И.А.',
      },
    });
    createdObjectIds.push(assigned.id, hidden.id);
    await prisma.propertyObjectEngineer.create({
      data: { propertyObjectId: assigned.id, userId: responsible.id },
    });

    const adminSession = await login(admin.email);
    const responsibleSession = await login(responsible.email);
    const contractorSession = await login(contractor.email);

    const unauthenticated = await inject({ method: 'GET', url: '/api/objects' });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.body).not.toMatch(/passwordHash/);

    expect(
      (
        await inject({
          method: 'GET',
          url: '/api/objects',
          cookies: { [SESSION_COOKIE_NAME]: contractorSession.cookie },
        })
      ).statusCode,
    ).toBe(403);

    const adminList = await inject({
      method: 'GET',
      url: `/api/objects?search=${encodeURIComponent('Objects')}&pageSize=50`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(adminList.statusCode).toBe(200);
    const adminBody = adminList.json() as {
      items: Array<Record<string, unknown>>;
      totalCount: number;
      pageSize: number;
    };
    expect(adminBody.items.some((item) => item.id === assigned.id)).toBe(true);
    expect(adminBody.items.some((item) => item.id === hidden.id)).toBe(true);
    expect(JSON.stringify(adminBody)).not.toMatch(/passwordHash|sourceImportKey|sourceSystem/);
    expect(adminBody.pageSize).toBeLessThanOrEqual(50);
    expect(adminBody).toMatchObject({ canCreate: true });

    const oversized = await inject({
      method: 'GET',
      url: '/api/objects?pageSize=51',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(oversized.statusCode).toBe(400);

    const injected = await inject({
      method: 'GET',
      url: `/api/objects?search=${encodeURIComponent("'; DROP TABLE property_objects; --")}`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(injected.statusCode).toBe(200);

    const responsibleList = await inject({
      method: 'GET',
      url: '/api/objects?pageSize=50',
      cookies: { [SESSION_COOKIE_NAME]: responsibleSession.cookie },
    });
    expect(responsibleList.statusCode).toBe(200);
    const responsibleBody = responsibleList.json() as {
      items: Array<{ id: string; name: string }>;
    };
    expect(responsibleBody.items.some((item) => item.id === assigned.id)).toBe(true);
    expect(responsibleBody.items.some((item) => item.id === hidden.id)).toBe(false);

    const assignedItem = adminBody.items.find((item) => item.id === assigned.id) as {
      responsibleEngineer: Record<string, unknown>;
    };
    expect(assignedItem.responsibleEngineer).toMatchObject({
      fullName: 'Василевич М.В.',
      linked: false,
      linkState: 'UNMATCHED',
    });
    expect(assignedItem.responsibleEngineer).not.toHaveProperty('email');
    expect(JSON.stringify(assignedItem)).not.toMatch(/passwordHash|sourceImportKey|credentials/);

    const created = await inject({
      method: 'POST',
      url: '/api/objects',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: { [CSRF_HEADER_NAME]: adminSession.csrfToken },
      payload: { name: `Objects created ${Date.now()}`, address: 'ул. Новая, 1' },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as { id: string; name: string };
    createdObjectIds.push(createdBody.id);
    expect(createdBody).not.toHaveProperty('sourceSystem');
    expect(JSON.stringify(createdBody)).not.toMatch(/passwordHash|csrfToken/);

    const usersBefore = await prisma.user.count();
    await inject({
      method: 'GET',
      url: '/api/objects',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(await prisma.user.count()).toBe(usersBefore);
  });

  it('lets ADMIN confirm a link, blocks other roles, and hides credentials', async () => {
    const admin = await createUser('ADMIN');
    const manager = await createUser('SGR_MANAGER');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
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
    const target = await prisma.user.create({
      data: {
        fullName: 'Богданович Иван Александрович',
        email: `objects.link.${Date.now()}@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
        status: 'ACTIVE',
        mustChangePassword: false,
      },
    });
    createdUserIds.push(target.id);
    await upsertUserCredentials(prisma, {
      userId: target.id,
      passwordHash: await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 }),
    });
    const object = await prisma.propertyObject.create({
      data: {
        name: `Objects link ${Date.now()}`,
        address: 'ул. Связь, 3',
        sortOrder: 30,
        sourceResponsibleEngineerName: 'Богданович И.А.',
      },
    });
    createdObjectIds.push(object.id);

    const adminSession = await login(admin.email);
    const managerSession = await login(manager.email);
    const responsibleSession = await login(responsible.email);
    const contractorSession = await login(contractor.email);
    const superSession = await login(superAdmin.email);

    const unknownFields = await inject({
      method: 'PATCH',
      url: `/api/objects/${object.id}/responsible-engineer`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: { [CSRF_HEADER_NAME]: adminSession.csrfToken },
      payload: { userId: target.id, extra: true },
    });
    expect(unknownFields.statusCode).toBe(400);

    const idor = await inject({
      method: 'PATCH',
      url: `/api/objects/${object.id}/responsible-engineer`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: { [CSRF_HEADER_NAME]: adminSession.csrfToken },
      payload: { userId: admin.id },
    });
    expect([400, 403, 422]).toContain(idor.statusCode);

    for (const session of [managerSession, responsibleSession, contractorSession, superSession]) {
      const denied = await inject({
        method: 'PATCH',
        url: `/api/objects/${object.id}/responsible-engineer`,
        cookies: { [SESSION_COOKIE_NAME]: session.cookie },
        headers: { [CSRF_HEADER_NAME]: session.csrfToken },
        payload: { userId: target.id },
      });
      expect(denied.statusCode).toBe(403);
    }

    const confirmed = await inject({
      method: 'PATCH',
      url: `/api/objects/${object.id}/responsible-engineer`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: { [CSRF_HEADER_NAME]: adminSession.csrfToken },
      payload: { userId: target.id },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(JSON.stringify(confirmed.json())).not.toMatch(/passwordHash|credentials|csrfToken/);

    const adminList = await inject({
      method: 'GET',
      url: `/api/objects?search=${encodeURIComponent(object.name)}&pageSize=50`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    const adminItem = (
      adminList.json() as {
        items: Array<{ id: string; responsibleEngineer: Record<string, unknown> }>;
      }
    ).items.find((item) => item.id === object.id);
    expect(adminItem?.responsibleEngineer).toMatchObject({
      id: target.id,
      fullName: 'Богданович Иван Александрович',
      linked: true,
      accessActive: true,
    });

    const superList = await inject({
      method: 'GET',
      url: `/api/objects?search=${encodeURIComponent(object.name)}&pageSize=50`,
      cookies: { [SESSION_COOKIE_NAME]: superSession.cookie },
    });
    expect(superList.statusCode).toBe(200);

    const targetSession = await login(target.email);
    const engineerList = await inject({
      method: 'GET',
      url: '/api/objects?pageSize=50',
      cookies: { [SESSION_COOKIE_NAME]: targetSession.cookie },
    });
    const engineerItems = (engineerList.json() as { items: Array<{ id: string }> }).items;
    expect(engineerItems.some((item) => item.id === object.id)).toBe(true);
    expect(JSON.stringify(engineerList.json())).not.toMatch(/passwordHash|sourceImportKey/);
  });

  it('auto-links objects when ADMIN creates a uniquely matching RESPONSIBLE_ENGINEER', async () => {
    const admin = await createUser('ADMIN');
    const object = await prisma.propertyObject.create({
      data: {
        name: `Objects autolink ${Date.now()}`,
        address: 'ул. Автопривязка, 1',
        sortOrder: 40,
        sourceResponsibleEngineerName: 'Единственный Э.Э.',
      },
    });
    createdObjectIds.push(object.id);
    const adminSession = await login(admin.email);
    const created = await inject({
      method: 'POST',
      url: '/api/users',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: { [CSRF_HEADER_NAME]: adminSession.csrfToken },
      payload: {
        fullName: 'Единственный Эдуард Эдуардович',
        email: `objects.autolink.${Date.now()}@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      user: { id: string; fullName: string };
      temporaryPassword?: string;
    };
    createdUserIds.push(body.user.id);
    expect(body.temporaryPassword).toBeTruthy();
    const link = await prisma.propertyObjectEngineer.findFirst({
      where: {
        propertyObjectId: object.id,
        unassignedAt: null,
        directoryLinkMethod: 'AUTO_EXACT',
      },
    });
    expect(link?.userId).toBe(body.user.id);

    const listed = await inject({
      method: 'GET',
      url: `/api/objects?search=${encodeURIComponent(object.name)}&pageSize=50`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    const item = (
      listed.json() as {
        items: Array<{ id: string; responsibleEngineer: Record<string, unknown> }>;
      }
    ).items.find((row) => row.id === object.id);
    expect(item?.responsibleEngineer).toMatchObject({
      id: body.user.id,
      fullName: 'Единственный Эдуард Эдуардович',
      linked: true,
      accessActive: true,
    });
  });

  it('lets ADMIN and SGR_MANAGER create objects and rejects everyone else', async () => {
    const admin = await createUser('ADMIN');
    const manager = await createUser('SGR_MANAGER');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
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
    const stamp = Date.now();
    const adminSession = await login(admin.email);
    const managerSession = await login(manager.email);
    const responsibleSession = await login(responsible.email);
    const contractorSession = await login(contractor.email);
    const superSession = await login(superAdmin.email);
    expect(
      (
        (
          await inject({
            method: 'GET',
            url: '/api/objects',
            cookies: { [SESSION_COOKIE_NAME]: superSession.cookie },
          })
        ).json() as { canCreate: boolean }
      ).canCreate,
    ).toBe(false);
    expect(
      (
        (
          await inject({
            method: 'GET',
            url: '/api/objects',
            cookies: { [SESSION_COOKIE_NAME]: managerSession.cookie },
          })
        ).json() as { canCreate: boolean }
      ).canCreate,
    ).toBe(true);

    expect(
      (await inject({ method: 'POST', url: '/api/objects', payload: { name: 'x' } })).statusCode,
    ).toBe(401);

    const noCsrf = await inject({
      method: 'POST',
      url: '/api/objects',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      payload: { name: `CSRF ${stamp}` },
    });
    expect(noCsrf.statusCode).toBe(403);

    const badOrigin = await inject({
      method: 'POST',
      url: '/api/objects',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: {
        origin: 'https://evil.example',
        [CSRF_HEADER_NAME]: adminSession.csrfToken,
      },
      payload: { name: `Origin ${stamp}` },
    });
    expect(badOrigin.statusCode).toBe(403);

    const unknown = await inject({
      method: 'POST',
      url: '/api/objects',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: { [CSRF_HEADER_NAME]: adminSession.csrfToken },
      payload: { name: `Unknown ${stamp}`, extra: true },
    });
    expect(unknown.statusCode).toBe(400);

    const invertedDates = await inject({
      method: 'POST',
      url: '/api/objects',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: { [CSRF_HEADER_NAME]: adminSession.csrfToken },
      payload: {
        name: `Dates ${stamp}`,
        commissionedAt: '2026-06-02',
        warrantyEndsAt: '2026-06-01',
      },
    });
    expect(invertedDates.statusCode).toBe(400);

    for (const session of [responsibleSession, contractorSession, superSession]) {
      const denied = await inject({
        method: 'POST',
        url: '/api/objects',
        cookies: { [SESSION_COOKIE_NAME]: session.cookie },
        headers: { [CSRF_HEADER_NAME]: session.csrfToken },
        payload: { name: `Denied ${stamp}` },
      });
      expect(denied.statusCode).toBe(403);
    }

    const textName = `Text FIO ${stamp}`;
    const withText = await inject({
      method: 'POST',
      url: '/api/objects',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: { [CSRF_HEADER_NAME]: adminSession.csrfToken },
      payload: {
        name: textName,
        address: 'ул. Текстовая, 1',
        responsibleEngineerName: 'Василевич М.В.',
      },
    });
    expect(withText.statusCode).toBe(201);
    const textBody = withText.json() as { id: string };
    createdObjectIds.push(textBody.id);
    expect(
      await prisma.propertyObjectEngineer.count({ where: { propertyObjectId: textBody.id } }),
    ).toBe(0);
    const listed = await inject({
      method: 'GET',
      url: `/api/objects?search=${encodeURIComponent(textName)}&pageSize=50`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    const listedItem = (
      listed.json() as {
        items: Array<{ id: string; responsibleEngineer: Record<string, unknown> }>;
      }
    ).items.find((item) => item.id === textBody.id);
    expect(listedItem?.responsibleEngineer).toMatchObject({
      fullName: 'Василевич М.В.',
      linked: false,
    });

    const managerName = `Manager ${stamp}`;
    const managerCreated = await inject({
      method: 'POST',
      url: '/api/objects',
      cookies: { [SESSION_COOKIE_NAME]: managerSession.cookie },
      headers: { [CSRF_HEADER_NAME]: managerSession.csrfToken },
      payload: { name: managerName, address: 'ул. Руководителя, 2' },
    });
    expect(managerCreated.statusCode).toBe(201);
    createdObjectIds.push((managerCreated.json() as { id: string }).id);

    const duplicate = await inject({
      method: 'POST',
      url: '/api/objects',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: { [CSRF_HEADER_NAME]: adminSession.csrfToken },
      payload: { name: textName, address: 'ул. Текстовая, 1' },
    });
    expect(duplicate.statusCode).toBe(409);

    const concurrentName = `Concurrent ${stamp}`;
    const concurrent = await Promise.all(
      [1, 2].map(() =>
        inject({
          method: 'POST',
          url: '/api/objects',
          cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
          headers: { [CSRF_HEADER_NAME]: adminSession.csrfToken },
          payload: { name: concurrentName, address: 'ул. Гонка, 3' },
        }),
      ),
    );
    const created = concurrent.filter((item) => item.statusCode === 201);
    const conflicts = concurrent.filter((item) => item.statusCode === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    createdObjectIds.push((created[0]?.json() as { id: string }).id);
    expect(JSON.stringify(concurrent.map((item) => item.json()))).not.toMatch(
      /passwordHash|DATABASE_URL/,
    );
  });
});
