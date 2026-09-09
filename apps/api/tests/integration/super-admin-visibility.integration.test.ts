import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  findSensitiveApiResponseLeaks,
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

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

async function inject(opts: {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
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
      'x-request-id': `sa-vis-${Date.now()}-${Math.random()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(
  role: UserRole,
  extras: { status?: 'ACTIVE' | 'ARCHIVED'; fullName?: string } = {},
) {
  const email = `vis.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: {
      ...personNameWriteFields(extras.fullName ?? `Visibility ${role}`),
      email,
      role,
      status: extras.status ?? 'ACTIVE',
      mustChangePassword: false,
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
    return createUser('SUPER_ADMIN', { fullName: 'Visibility Super A' });
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

async function login(email: string) {
  const response = await inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: DEMO_PASSWORD },
  });
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value ?? '';
  const body = response.json() as { csrfToken?: string };
  return { cookie, csrfToken: body.csrfToken ?? '' };
}

function mutate(
  session: { cookie: string; csrfToken: string },
  opts: {
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    url: string;
    payload?: unknown;
  },
) {
  return inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload,
    cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    headers: { [CSRF_HEADER_NAME]: session.csrfToken },
  });
}

describe('SUPER_ADMIN complete read-only visibility', () => {
  beforeAll(async () => {
    prisma = createOwnerPrismaClient(loadConfig().MIGRATION_DATABASE_URL);
    redis = new Redis(loadConfig().REDIS_URL, { maxRetriesPerRequest: 1 });
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: false,
    });
    await configureHttpApp(app, loadConfig());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
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
      await prisma.user.updateMany({
        where: { id: { in: createdUserIds } },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
    }
    await app.close();
    await redis.quit();
    await disconnectPrismaClient();
  });

  it('lists every user and role, hides secrets, and blocks business mutations', async () => {
    const superA = await ensureActiveSuperAdmin();
    const superB = await createUser('SUPER_ADMIN', {
      status: 'ARCHIVED',
      fullName: 'Visibility Super B',
    });
    const admin = await createUser('ADMIN');
    const archived = await createUser('SGR_MANAGER', { status: 'ARCHIVED' });
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const sa = await login(superA.email);
    const adminSession = await login(admin.email);

    const users = await inject({
      method: 'GET',
      url: `/api/users?pageSize=100&role=SUPER_ADMIN`,
      cookies: { [SESSION_COOKIE_NAME]: sa.cookie },
    });
    expect(users.statusCode).toBe(200);
    const usersBody = users.json() as {
      items: Array<{
        id: string;
        role: string;
        status: string;
        passwordConfigured?: boolean;
        passwordChangedAt?: string | null;
        activeSessionsCount?: number;
      }>;
    };
    expect(usersBody.items.some((item) => item.id === superA.id)).toBe(true);
    expect(
      usersBody.items.some((item) => item.id === superB.id && item.status === 'ARCHIVED'),
    ).toBe(true);
    const archivedList = await inject({
      method: 'GET',
      url: `/api/users?pageSize=100&search=${encodeURIComponent(archived.email)}`,
      cookies: { [SESSION_COOKIE_NAME]: sa.cookie },
    });
    expect(archivedList.statusCode).toBe(200);
    expect(
      (archivedList.json() as { items: Array<{ id: string; status: string }> }).items.some(
        (item) => item.id === archived.id && item.status === 'ARCHIVED',
      ),
    ).toBe(true);
    const self = usersBody.items.find((item) => item.id === superA.id);
    expect(self?.passwordConfigured).toBe(true);
    expect(self?.activeSessionsCount).toBeGreaterThanOrEqual(1);
    expect(findSensitiveApiResponseLeaks(usersBody)).toEqual([]);
    expect(findSensitiveApiResponseLeaks(archivedList.json())).toEqual([]);

    const adminUsers = await inject({
      method: 'GET',
      url: `/api/users?pageSize=100&role=SUPER_ADMIN`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(adminUsers.statusCode).toBe(200);
    const adminItems = (adminUsers.json() as { items: Array<{ id: string; role: string }> }).items;
    expect(adminItems.some((item) => item.id === superA.id)).toBe(false);
    expect(adminItems.some((item) => item.role === 'SUPER_ADMIN')).toBe(false);

    const history = await inject({
      method: 'GET',
      url: `/api/users/${superB.id}/history?limit=20`,
      cookies: { [SESSION_COOKIE_NAME]: sa.cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(findSensitiveApiResponseLeaks(history.json())).toEqual([]);

    const hiddenHistory = await inject({
      method: 'GET',
      url: `/api/users/${superB.id}/history`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
    });
    expect(hiddenHistory.statusCode).toBe(404);

    for (const url of [
      '/api/registry/defects?pageSize=50',
      '/api/registry/summary',
      '/api/objects?pageSize=50',
      '/api/notifications?pageSize=20',
      '/api/audit-log?pageSize=20',
      '/api/system-status',
      '/api/system/notification-settings',
      '/api/reference-data/work-types?status=ALL',
      '/api/reference-data/defect-types?status=ALL',
      '/api/sla/summary',
    ]) {
      const response = await inject({
        method: 'GET',
        url,
        cookies: { [SESSION_COOKIE_NAME]: sa.cookie },
      });
      expect(response.statusCode, url).toBe(200);
      expect(findSensitiveApiResponseLeaks(response.json()), url).toEqual([]);
    }

    const audit = await inject({
      method: 'GET',
      url: '/api/audit-log?page=1&pageSize=10',
      cookies: { [SESSION_COOKIE_NAME]: sa.cookie },
    });
    const auditBody = audit.json() as { pageSize: number; items: unknown[] };
    expect(auditBody.pageSize).toBe(10);
    expect(auditBody.pageSize).toBeLessThanOrEqual(100);

    expect(
      (await mutate(sa, { method: 'POST', url: '/api/acts', payload: { formCode: 'S1' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await mutate(sa, { method: 'POST', url: '/api/objects', payload: { name: 'x' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(sa, {
          method: 'POST',
          url: `/api/users/${engineer.id}/archive`,
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await mutate(sa, { method: 'POST', url: '/api/notifications/read-all' })).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(sa, {
          method: 'PATCH',
          url: '/api/system/notification-settings',
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(403);
    expect((await mutate(sa, { method: 'POST', url: '/api/system-status' })).statusCode).toBe(403);
    expect(
      (
        await mutate(sa, {
          method: 'POST',
          url: '/api/reference-data/work-types',
          payload: { code: 'X', name: 'X' },
        })
      ).statusCode,
    ).toBe(403);
  });
});
