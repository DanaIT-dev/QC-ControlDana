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

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

let app: NestFastifyApplication;
let prisma: PrismaClient;
let redis: Redis;
const createdUserIds: string[] = [];

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
  body: string;
  cookies: Array<{ name: string; value: string }>;
  headers: Record<string, string | string[] | undefined>;
}

async function inject(opts: {
  method: string;
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
      'x-request-id': `sec-${Date.now()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(role: 'ADMIN' | 'RESPONSIBLE_ENGINEER') {
  const email = `sec.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: { fullName: `Sec ${role}`, email, role, status: 'ACTIVE', passwordHash },
  });
  createdUserIds.push(user.id);
  return user;
}

describe('API security harness', () => {
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
    await app?.close();
    await redis?.quit();
    await prisma?.$disconnect();
    await disconnectPrismaClient();
  });

  it('rejects unauthenticated product routes and attachment download', async () => {
    const urls = [
      '/api/registry/defects',
      '/api/system-status',
      '/api/notifications',
      '/api/sla/items',
      '/api/attachments/11111111-1111-4111-8111-111111111111',
      '/api/attachments/11111111-1111-4111-8111-111111111111/content',
    ];
    for (const url of urls) {
      const response = await inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toMatch(/passwordHash|Dana-SGR-Demo-2026!/);
    }
  });

  it('does not reflect an evil CORS origin', async () => {
    const response = await inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(200);
    const allow = String(response.headers['access-control-allow-origin'] ?? '');
    expect(allow).not.toBe('https://evil.example');
    expect(allow).toBe(loadConfig().WEB_ORIGIN);
  });

  it('rejects SQL injection, XSS and header-injection login payloads', async () => {
    const payloads = [
      "' OR 1=1 --",
      '<script>alert(1)</script>',
      'admin@example.sgr.local\r\nSet-Cookie: hijack=1',
    ];
    for (const email of payloads) {
      const response = await inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: DEMO_PASSWORD },
        headers: { 'x-request-id': 'sec\r\nX-Injected: 1' },
      });
      expect([400, 401]).toContain(response.statusCode);
      expect(JSON.stringify(response.headers)).not.toMatch(/X-Injected|hijack=1/i);
      expect(response.body).not.toContain('<script>');
    }
  });

  it('rejects path traversal and method confusion on attachments', async () => {
    const user = await createUser('ADMIN');
    const loggedIn = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: DEMO_PASSWORD },
    });
    const sessionId = loggedIn.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value;
    const csrfToken = (loggedIn.json() as { csrfToken: string }).csrfToken;
    const traversal = await inject({
      method: 'GET',
      url: '/api/attachments/..%2f..%2fetc%2fpasswd',
      cookies: { [SESSION_COOKIE_NAME]: sessionId! },
    });
    expect([400, 404]).toContain(traversal.statusCode);
    expect(traversal.body).not.toMatch(/root:|passwordHash/);
    const confused = await inject({
      method: 'GET',
      url: '/api/auth/login',
    });
    expect(confused.statusCode).toBeGreaterThanOrEqual(400);
    const csrfMissing = await inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: {},
      cookies: { [SESSION_COOKIE_NAME]: sessionId! },
    });
    expect(csrfMissing.statusCode).toBe(403);
    const logout = await inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: {},
      cookies: { [SESSION_COOKIE_NAME]: sessionId! },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(logout.statusCode).toBe(200);
  });

  it('rejects oversized JSON without opening an unauthenticated redirect', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `${'a'.repeat(20_000)}@example.sgr.local`, password: 'x'.repeat(20_000) },
      headers: { origin: 'https://evil.example' },
    });
    expect([400, 401, 403, 413]).toContain(response.statusCode);
    expect(response.headers.location).toBeUndefined();
  });

  it('does not leak B/C fields to RESPONSIBLE_ENGINEER on registry or notifications', async () => {
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const loggedIn = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: responsible.email, password: DEMO_PASSWORD },
    });
    const sessionId = loggedIn.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value;
    const registry = await inject({
      method: 'GET',
      url: '/api/registry/defects?pageSize=50',
      cookies: { [SESSION_COOKIE_NAME]: sessionId! },
    });
    expect(registry.statusCode).toBe(200);
    const serialized = JSON.stringify(registry.json());
    expect(serialized).not.toMatch(/"slot":"B"/);
    expect(serialized).not.toMatch(/proposalsBC/);
    const notifications = await inject({
      method: 'GET',
      url: '/api/notifications',
      cookies: { [SESSION_COOKIE_NAME]: sessionId! },
    });
    expect(notifications.statusCode).toBe(200);
    expect(JSON.stringify(notifications.json())).not.toMatch(/proposalsBC|"slot":"B"/);
  });
});
