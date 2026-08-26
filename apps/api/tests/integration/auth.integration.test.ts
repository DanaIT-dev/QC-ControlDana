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
import {
  AUTH_LOGIN_FAILED_MESSAGE,
  AUTH_RATE_LIMITED_MESSAGE,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  capabilitiesForRole,
} from '@sgr-registry/domain';
import Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/configure-http';
import { hashArgon2id, hashSessionId } from '../../src/auth/crypto';
import type { UserRole } from '@sgr-registry/contracts';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const WRONG_PASSWORD = 'Wrong-Password-2026!';

let app: NestFastifyApplication;
let prisma: PrismaClient;
let redis: Redis;
const createdUserIds: string[] = [];

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
  cookies: Array<{
    name: string;
    value: string;
    httpOnly?: boolean;
    path?: string;
    sameSite?: string | { value: string };
    maxAge?: number;
  }>;
  headers: Record<string, string | string[] | undefined>;
}

async function inject(opts: {
  method: 'GET' | 'POST';
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
      'x-request-id': `itest-${Date.now()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

function cookieValue(response: InjectResponse): string | undefined {
  return response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value;
}

async function createUser(role: UserRole, status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE') {
  const email = `itest.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: {
      fullName: `Тест ${role}`,
      email,
      role,
      status,
      passwordHash,
      archivedAt: status === 'ARCHIVED' ? new Date() : null,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

async function login(email: string, password: string) {
  return inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
}

describe('auth integration', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.REDIS_KEY_PREFIX = 'sgr-test';
    process.env.AUTH_LOGIN_WINDOW_SECONDS = '30';
    process.env.AUTH_LOGIN_MAX_FAILURES = '5';
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

  it('logs in successfully with an HttpOnly Lax cookie and a Redis session', async () => {
    const user = await createUser('ADMIN');
    const response = await login(user.email, DEMO_PASSWORD);
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.passwordHash).toBeUndefined();
    expect(body.sessionId).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(user.passwordHash ?? 'argon2');
    const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE_NAME);
    expect(cookie?.httpOnly).toBe(true);
    expect(String(cookie?.sameSite ?? '').toLowerCase()).toContain('lax');
    expect(cookie?.path).toBe('/');
    expect(cookie?.value).toBeTruthy();
    const stored = await redis.get(`sgr-test:sess:${hashSessionId(cookie!.value)}`);
    expect(stored).toBeTruthy();
    const audit = await prisma.auditLog.findFirst({
      where: { actorUserId: user.id, action: 'LOGIN_SUCCEEDED' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toMatch(/passwordHash|Dana-SGR-Demo-2026!|sgr_session=/);
  });

  it('returns the same error for a wrong password and does not set a cookie', async () => {
    const user = await createUser('ADMIN');
    const response = await login(user.email, WRONG_PASSWORD);
    expect(response.statusCode).toBe(401);
    expect((response.json() as { message: string }).message).toBe(AUTH_LOGIN_FAILED_MESSAGE);
    expect(cookieValue(response)).toBeUndefined();
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: user.id, action: 'LOGIN_FAILED' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit).toBeTruthy();
  });

  it('returns the same status and message for an unknown email', async () => {
    const response = await login('missing.user@example.sgr.local', DEMO_PASSWORD);
    expect(response.statusCode).toBe(401);
    expect((response.json() as { message: string }).message).toBe(AUTH_LOGIN_FAILED_MESSAGE);
    expect(cookieValue(response)).toBeUndefined();
  });

  it('rejects an ARCHIVED user with the generic login error', async () => {
    const user = await createUser('ADMIN', 'ARCHIVED');
    const response = await login(user.email, DEMO_PASSWORD);
    expect(response.statusCode).toBe(401);
    expect((response.json() as { message: string }).message).toBe(AUTH_LOGIN_FAILED_MESSAGE);
    expect(cookieValue(response)).toBeUndefined();
  });

  it('returns a safe profile from /auth/me', async () => {
    const user = await createUser('SGR_MANAGER');
    const loggedIn = await login(user.email, DEMO_PASSWORD);
    const me = await inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: cookieValue(loggedIn)! },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json() as Record<string, unknown>;
    expect(body.email).toBe(user.email);
    expect(body.role).toBe('SGR_MANAGER');
    expect(body.roleLabel).toBe('Руководитель СГР');
    expect(body.passwordHash).toBeUndefined();
    expect(body.csrfToken).toBeTruthy();
  });

  it('logout deletes the session and clears the cookie', async () => {
    const user = await createUser('ADMIN');
    const loggedIn = await login(user.email, DEMO_PASSWORD);
    const sessionId = cookieValue(loggedIn)!;
    const csrfToken = (loggedIn.json() as { csrfToken: string }).csrfToken;
    const logout = await inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: {},
      cookies: { [SESSION_COOKIE_NAME]: sessionId },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(logout.statusCode).toBe(200);
    expect(await redis.get(`sgr-test:sess:${hashSessionId(sessionId)}`)).toBeNull();
    const me = await inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: sessionId },
    });
    expect(me.statusCode).toBe(401);
    const secondLogout = await inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: {},
      cookies: { [SESSION_COOKIE_NAME]: sessionId },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(secondLogout.statusCode).toBe(401);
  });

  it('logout-all invalidates two real sessions of the same user', async () => {
    const user = await createUser('ADMIN');
    const first = await login(user.email, DEMO_PASSWORD);
    const second = await login(user.email, DEMO_PASSWORD);
    const firstId = cookieValue(first)!;
    const secondId = cookieValue(second)!;
    expect(firstId).not.toBe(secondId);
    const csrfToken = (first.json() as { csrfToken: string }).csrfToken;
    const logoutAll = await inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      payload: {},
      cookies: { [SESSION_COOKIE_NAME]: firstId },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(logoutAll.statusCode).toBe(200);
    const firstMe = await inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: firstId },
    });
    const secondMe = await inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: secondId },
    });
    expect(firstMe.statusCode).toBe(401);
    expect(secondMe.statusCode).toBe(401);
  });

  it('rejects a session after sessionVersion mismatch', async () => {
    const user = await createUser('ADMIN');
    const loggedIn = await login(user.email, DEMO_PASSWORD);
    await prisma.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 } },
    });
    const me = await inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: cookieValue(loggedIn)! },
    });
    expect(me.statusCode).toBe(401);
    const audit = await prisma.auditLog.findFirst({
      where: { actorUserId: user.id, action: 'SESSION_REJECTED_VERSION_MISMATCH' },
    });
    expect(audit).toBeTruthy();
  });

  it('rate-limits login after the configured number of failures without waiting 15 minutes', async () => {
    const user = await createUser('ADMIN');
    for (let i = 0; i < 5; i += 1) {
      const failed = await login(user.email, WRONG_PASSWORD);
      expect(failed.statusCode).toBe(401);
    }
    const limited = await login(user.email, WRONG_PASSWORD);
    expect(limited.statusCode).toBe(429);
    expect((limited.json() as { message: string }).message).toBe(AUTH_RATE_LIMITED_MESSAGE);
    const failKeys = await redis.keys('sgr-test:login-fail:*');
    expect(failKeys.length).toBeGreaterThan(0);
    const ttl = await redis.ttl(failKeys[0]!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('requires a valid CSRF token for logout', async () => {
    const user = await createUser('ADMIN');
    const loggedIn = await login(user.email, DEMO_PASSWORD);
    const sessionId = cookieValue(loggedIn)!;
    const csrfToken = (loggedIn.json() as { csrfToken: string }).csrfToken;
    const missing = await inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: {},
      cookies: { [SESSION_COOKIE_NAME]: sessionId },
    });
    const wrong = await inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: {},
      cookies: { [SESSION_COOKIE_NAME]: sessionId },
      headers: { [CSRF_HEADER_NAME]: 'not-the-token' },
    });
    const ok = await inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: {},
      cookies: { [SESSION_COOKIE_NAME]: sessionId },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(missing.statusCode).toBe(403);
    expect(wrong.statusCode).toBe(403);
    expect(ok.statusCode).toBe(200);
  });

  it('returns the expected capabilities for each role', async () => {
    const roles: UserRole[] = [
      'ADMIN',
      'SGR_MANAGER',
      'RESPONSIBLE_ENGINEER',
      'CONTRACTOR_ENGINEER',
    ];
    for (const role of roles) {
      const user = await createUser(role);
      const loggedIn = await login(user.email, DEMO_PASSWORD);
      const response = await inject({
        method: 'GET',
        url: '/api/auth/capabilities',
        cookies: { [SESSION_COOKIE_NAME]: cookieValue(loggedIn)! },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { capabilities: string[] };
      expect(body.capabilities).toEqual([...capabilitiesForRole(role)]);
    }
  });

  it('does not store secrets in AuditLog', async () => {
    const user = await createUser('ADMIN');
    await login(user.email, WRONG_PASSWORD);
    await login(user.email, DEMO_PASSWORD);
    const logs = await prisma.auditLog.findMany({
      where: { OR: [{ actorUserId: user.id }, { entityId: user.id }] },
    });
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) {
      const serialized = JSON.stringify(log);
      expect(serialized).not.toContain(DEMO_PASSWORD);
      expect(serialized).not.toContain(WRONG_PASSWORD);
      expect(serialized).not.toContain('passwordHash');
      expect(serialized.toLowerCase()).not.toContain('sgr_session=');
      expect(serialized).not.toMatch(/csrfToken":"[A-Za-z0-9_-]{20,}/);
    }
  });

  it('protects system-status for non-admin users', async () => {
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const admin = await createUser('ADMIN');
    const engineerSession = cookieValue(await login(engineer.email, DEMO_PASSWORD))!;
    const adminSession = cookieValue(await login(admin.email, DEMO_PASSWORD))!;
    const forbidden = await inject({
      method: 'GET',
      url: '/api/system-status',
      cookies: { [SESSION_COOKIE_NAME]: engineerSession },
    });
    const allowed = await inject({
      method: 'GET',
      url: '/api/system-status',
      cookies: { [SESSION_COOKIE_NAME]: adminSession },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
  });
});
