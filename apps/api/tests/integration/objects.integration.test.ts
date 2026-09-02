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
      await prisma.user.updateMany({
        where: { id: { in: createdUserIds }, role: 'SUPER_ADMIN' },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
      await prisma.user
        .deleteMany({ where: { id: { in: createdUserIds } } })
        .catch(() => undefined);
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

    const missingWrite = await inject({
      method: 'POST',
      url: '/api/objects',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: { [CSRF_HEADER_NAME]: adminSession.csrfToken },
      payload: { name: 'x' },
    });
    expect(missingWrite.statusCode).toBe(404);

    const usersBefore = await prisma.user.count();
    await inject({
      method: 'GET',
      url: '/api/objects',
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(await prisma.user.count()).toBe(usersBefore);
  });
});
