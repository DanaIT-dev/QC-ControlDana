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
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME, capabilitiesForRole } from '@sgr-registry/domain';
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
      'x-request-id': `sa-${Date.now()}-${Math.random()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(role: UserRole, extras: { status?: 'ACTIVE' | 'ARCHIVED' } = {}) {
  const email = `sa.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: {
      fullName: `SA ${role}`,
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

async function login(email: string) {
  const response = await inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: DEMO_PASSWORD },
  });
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value;
  const body = response.json() as { csrfToken?: string; role?: string; id?: string };
  return { response, cookie: cookie ?? '', csrfToken: body.csrfToken ?? '', body };
}

async function mutate(
  session: { cookie: string; csrfToken: string },
  opts: {
    method: 'POST' | 'PATCH' | 'DELETE';
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
    headers: { [CSRF_HEADER_NAME]: session.csrfToken, ...opts.headers },
  });
}

describe('super-admin admin grants', () => {
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

  it('grants and revokes ADMIN with session invalidation, isolation and last-admin protection', async () => {
    await prisma.user.updateMany({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    const superAdmin = await createUser('SUPER_ADMIN');
    const adminA = await createUser('ADMIN');
    const manager = await createUser('SGR_MANAGER');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const archived = await createUser('SGR_MANAGER', { status: 'ARCHIVED' });
    const ordinaryAdmin = await createUser('ADMIN');
    const sgr = await createUser('SGR_MANAGER');
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const contractorTwo = await createUser('CONTRACTOR_ENGINEER');

    const object = await prisma.propertyObject.create({
      data: { name: `sa-object-${Date.now()}`, address: 'addr' },
    });
    createdObjectIds.push(object.id);
    await prisma.propertyObjectEngineer.create({
      data: { propertyObjectId: object.id, userId: responsible.id, assignedByUserId: adminA.id },
    });

    const sa = await login(superAdmin.email);
    const adminSession = await login(ordinaryAdmin.email);
    const managerSession = await login(manager.email);
    const responsibleSession = await login(responsible.email);
    const contractorSession = await login(contractor.email);
    const grantedManagerSession = await login(sgr.email);

    expect(sa.body.role).toBe('SUPER_ADMIN');
    expect(JSON.stringify(sa.body)).not.toMatch(/passwordHash|sessionVersion/);
    expect(capabilitiesForRole('SUPER_ADMIN')).not.toContain('MANAGE_USERS');

    const unauth = await inject({ method: 'GET', url: '/api/super-admin/admins' });
    expect(unauth.statusCode).toBe(401);

    for (const session of [adminSession, managerSession, responsibleSession, contractorSession]) {
      expect(
        (
          await inject({
            method: 'GET',
            url: '/api/super-admin/admins',
            cookies: { [SESSION_COOKIE_NAME]: session.cookie },
          })
        ).statusCode,
      ).toBe(403);
    }

    const admins = await inject({
      method: 'GET',
      url: '/api/super-admin/admins',
      cookies: { [SESSION_COOKIE_NAME]: sa.cookie },
    });
    expect(admins.statusCode).toBe(200);
    const adminList = admins.json() as { items: Array<Record<string, unknown>> };
    expect(adminList.items.some((item) => item.id === adminA.id)).toBe(true);
    expect(JSON.stringify(adminList)).not.toMatch(/passwordHash|sessionVersion|csrfToken/);

    const eligible = await inject({
      method: 'GET',
      url: '/api/super-admin/eligible-users',
      cookies: { [SESSION_COOKIE_NAME]: sa.cookie },
    });
    expect(eligible.statusCode).toBe(200);
    const eligibleList = eligible.json() as { items: Array<{ id: string; currentRole: string }> };
    expect(eligibleList.items.some((item) => item.id === sgr.id)).toBe(true);
    expect(eligibleList.items.some((item) => item.id === contractor.id)).toBe(true);
    expect(eligibleList.items.some((item) => item.id === superAdmin.id)).toBe(false);

    const missingCsrf = await inject({
      method: 'POST',
      url: `/api/super-admin/admins/${sgr.id}`,
      payload: { expectedVersion: sgr.version },
      cookies: { [SESSION_COOKIE_NAME]: sa.cookie },
    });
    expect(missingCsrf.statusCode).toBe(403);

    const missingOrigin = await mutate(sa, {
      method: 'POST',
      url: `/api/super-admin/admins/${sgr.id}`,
      payload: { expectedVersion: sgr.version },
      headers: { origin: 'http://evil.example' },
    });
    expect(missingOrigin.statusCode).toBe(403);

    const unknownField = await mutate(sa, {
      method: 'POST',
      url: `/api/super-admin/admins/${sgr.id}`,
      payload: { expectedVersion: sgr.version, role: 'ADMIN' },
    });
    expect(unknownField.statusCode).toBe(400);

    const granted = await mutate(sa, {
      method: 'POST',
      url: `/api/super-admin/admins/${sgr.id}`,
      payload: { expectedVersion: sgr.version },
    });
    expect(granted.statusCode).toBe(200);
    const grantedBody = granted.json() as { currentRole: string; version: number };
    expect(grantedBody.currentRole).toBe('ADMIN');
    const storedGrant = await prisma.user.findUniqueOrThrow({ where: { id: sgr.id } });
    expect(storedGrant.role).toBe('ADMIN');
    expect(storedGrant.roleBeforeAdmin).toBe('SGR_MANAGER');

    const staleManager = await inject({
      method: 'GET',
      url: '/api/registry/defects',
      cookies: { [SESSION_COOKIE_NAME]: grantedManagerSession.cookie },
    });
    expect(staleManager.statusCode).toBe(401);

    const repeatGrant = await mutate(sa, {
      method: 'POST',
      url: `/api/super-admin/admins/${sgr.id}`,
      payload: { expectedVersion: grantedBody.version },
    });
    expect(repeatGrant.statusCode).toBe(200);

    const grantedResp = await mutate(sa, {
      method: 'POST',
      url: `/api/super-admin/admins/${responsible.id}`,
      payload: { expectedVersion: responsible.version },
    });
    expect(grantedResp.statusCode).toBe(200);
    const storedResp = await prisma.user.findUniqueOrThrow({ where: { id: responsible.id } });
    expect(storedResp.roleBeforeAdmin).toBe('RESPONSIBLE_ENGINEER');
    const assignment = await prisma.propertyObjectEngineer.findFirst({
      where: { userId: responsible.id, propertyObjectId: object.id },
    });
    expect(assignment?.unassignedAt).toBeNull();

    expect(
      (
        await mutate(sa, {
          method: 'POST',
          url: `/api/super-admin/admins/${contractorTwo.id}`,
          payload: { expectedVersion: contractorTwo.version },
        })
      ).statusCode,
    ).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: contractorTwo.id } })).role).toBe(
      'ADMIN',
    );
    expect(
      (
        await mutate(sa, {
          method: 'DELETE',
          url: `/api/super-admin/admins/${contractorTwo.id}`,
          payload: {
            expectedVersion: (
              await prisma.user.findUniqueOrThrow({ where: { id: contractorTwo.id } })
            ).version,
          },
        })
      ).statusCode,
    ).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: contractorTwo.id } })).role).toBe(
      'CONTRACTOR_ENGINEER',
    );
    expect(
      (
        await mutate(sa, {
          method: 'POST',
          url: `/api/super-admin/admins/${archived.id}`,
          payload: { expectedVersion: archived.version },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await mutate(sa, {
          method: 'POST',
          url: `/api/super-admin/admins/${superAdmin.id}`,
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(400);

    const revoked = await mutate(sa, {
      method: 'DELETE',
      url: `/api/super-admin/admins/${sgr.id}`,
      payload: {
        expectedVersion: (await prisma.user.findUniqueOrThrow({ where: { id: sgr.id } })).version,
      },
    });
    if (revoked.statusCode !== 200) {
      throw new Error(`revoke failed ${revoked.statusCode} ${revoked.body}`);
    }
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as { currentRole: string }).currentRole).toBe('SGR_MANAGER');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: sgr.id } })).roleBeforeAdmin,
    ).toBeNull();

    const repeatRevoke = await mutate(sa, {
      method: 'DELETE',
      url: `/api/super-admin/admins/${sgr.id}`,
      payload: {
        expectedVersion: (await prisma.user.findUniqueOrThrow({ where: { id: sgr.id } })).version,
      },
    });
    expect(repeatRevoke.statusCode).toBe(200);

    const afterResponsible = await mutate(sa, {
      method: 'DELETE',
      url: `/api/super-admin/admins/${responsible.id}`,
      payload: {
        expectedVersion: (await prisma.user.findUniqueOrThrow({ where: { id: responsible.id } }))
          .version,
      },
    });
    expect(afterResponsible.statusCode).toBe(200);
    expect((afterResponsible.json() as { currentRole: string }).currentRole).toBe(
      'RESPONSIBLE_ENGINEER',
    );
    expect(
      await prisma.propertyObjectEngineer.count({
        where: { userId: responsible.id, propertyObjectId: object.id, unassignedAt: null },
      }),
    ).toBe(1);

    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: `/api/super-admin/admins/${engineer.id}`,
          payload: { expectedVersion: engineer.version },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(adminSession, {
          method: 'PATCH',
          url: `/api/users/${ordinaryAdmin.id}`,
          payload: { expectedVersion: 1, role: 'SGR_MANAGER' },
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: '/api/users',
          payload: { fullName: 'X', email: 'x-sa@example.sgr.local', role: 'SUPER_ADMIN' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await mutate(adminSession, {
          method: 'POST',
          url: '/api/users',
          payload: { fullName: 'Y', email: 'y-sa@example.sgr.local', role: 'ADMIN' },
        })
      ).statusCode,
    ).toBe(400);

    const pendingEmail = `pending.${Date.now()}@example.sgr.local`;
    const injectedRole = await mutate(sa, {
      method: 'POST',
      url: '/api/super-admin/users',
      payload: { fullName: 'Pending Inject', email: pendingEmail, role: 'ADMIN' },
    });
    expect(injectedRole.statusCode).toBe(400);
    expect(await prisma.user.findUnique({ where: { email: pendingEmail } })).toBeNull();

    const createdPending = await mutate(sa, {
      method: 'POST',
      url: '/api/super-admin/users',
      payload: { fullName: 'Pending User', email: pendingEmail },
    });
    expect(createdPending.statusCode).toBe(201);
    const pendingBody = createdPending.json() as {
      user: { id: string; role: string };
      temporaryPassword?: string;
    };
    expect(pendingBody.user.role).toBe('PENDING_ROLE');
    expect(pendingBody.temporaryPassword).toBeTruthy();
    expect(JSON.stringify(createdPending.json())).not.toMatch(/passwordHash/);
    createdUserIds.push(pendingBody.user.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: pendingBody.user.id } })).role).toBe(
      'PENDING_ROLE',
    );
    const pendingAudit = await prisma.auditLog.findFirst({
      where: { action: 'USER_CREATED_PENDING_ROLE', entityId: pendingBody.user.id },
    });
    expect(pendingAudit).toBeTruthy();
    expect(JSON.stringify(pendingAudit)).not.toMatch(/passwordHash|temporaryPassword/);

    const pendingLoginResponse = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: pendingEmail, password: pendingBody.temporaryPassword },
    });
    expect(pendingLoginResponse.statusCode).toBe(200);
    const pendingLogin = {
      cookie:
        pendingLoginResponse.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value ?? '',
      body: pendingLoginResponse.json() as { role?: string },
    };
    expect(pendingLogin.body.role).toBe('PENDING_ROLE');
    expect(
      (
        await inject({
          method: 'GET',
          url: '/api/registry/defects',
          cookies: { [SESSION_COOKIE_NAME]: pendingLogin.cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await inject({
          method: 'GET',
          url: `/api/acts/${object.id}/chat/mention-candidates`,
          cookies: { [SESSION_COOKIE_NAME]: pendingLogin.cookie },
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);

    expect(
      (
        await mutate(sa, {
          method: 'PATCH',
          url: `/api/users/${pendingBody.user.id}`,
          payload: { expectedVersion: 1, role: 'SGR_MANAGER' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: pendingBody.user.id } })).role).toBe(
      'SGR_MANAGER',
    );
    const assigned = await mutate(adminSession, {
      method: 'PATCH',
      url: `/api/users/${pendingBody.user.id}`,
      payload: {
        expectedVersion: (
          await prisma.user.findUniqueOrThrow({ where: { id: pendingBody.user.id } })
        ).version,
        role: 'SGR_MANAGER',
      },
    });
    expect(assigned.statusCode).toBe(200);
    expect((assigned.json() as { role: string }).role).toBe('SGR_MANAGER');
    expect(
      (
        await prisma.auditLog.findFirst({
          where: { action: 'USER_ROLE_ASSIGNED', entityId: pendingBody.user.id },
        })
      )?.action,
    ).toBe('USER_ROLE_ASSIGNED');
    expect(
      (
        await inject({
          method: 'GET',
          url: '/api/registry/defects',
          cookies: { [SESSION_COOKIE_NAME]: pendingLogin.cookie },
        })
      ).statusCode,
    ).toBe(401);

    const pendingGrantEmail = `pending.grant.${Date.now()}@example.sgr.local`;
    const pendingForGrant = await mutate(sa, {
      method: 'POST',
      url: '/api/super-admin/users',
      payload: { fullName: 'Pending Grant', email: pendingGrantEmail },
    });
    expect(pendingForGrant.statusCode).toBe(201);
    const pendingGrantId = (pendingForGrant.json() as { user: { id: string } }).user.id;
    createdUserIds.push(pendingGrantId);
    expect(
      (
        await mutate(sa, {
          method: 'POST',
          url: `/api/super-admin/admins/${pendingGrantId}`,
          payload: {
            expectedVersion: (
              await prisma.user.findUniqueOrThrow({ where: { id: pendingGrantId } })
            ).version,
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: pendingGrantId } })).roleBeforeAdmin,
    ).toBe('UNASSIGNED');
    expect(
      (
        await mutate(sa, {
          method: 'DELETE',
          url: `/api/super-admin/admins/${pendingGrantId}`,
          payload: {
            expectedVersion: (
              await prisma.user.findUniqueOrThrow({ where: { id: pendingGrantId } })
            ).version,
          },
        })
      ).statusCode,
    ).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: pendingGrantId } })).role).toBe(
      'PENDING_ROLE',
    );

    const business = await inject({
      method: 'GET',
      url: '/api/registry/defects',
      cookies: { [SESSION_COOKIE_NAME]: sa.cookie },
    });
    expect(business.statusCode).toBe(200);
    expect(business.body).not.toMatch(/passwordHash/);
    for (const url of [
      '/api/users',
      '/api/notifications',
      '/api/reference-data/property-objects',
      '/api/objects',
      '/api/audit-log',
    ]) {
      expect(
        (
          await inject({
            method: 'GET',
            url,
            cookies: { [SESSION_COOKIE_NAME]: sa.cookie },
          })
        ).statusCode,
      ).toBe(200);
    }
    expect(
      (
        await mutate(sa, {
          method: 'POST',
          url: '/api/acts',
          payload: { formCode: 'S1', objectId: object.id },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(sa, {
          method: 'PATCH',
          url: `/api/users/${ordinaryAdmin.id}`,
          payload: { expectedVersion: ordinaryAdmin.version, role: 'SGR_MANAGER' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ordinaryAdmin.id } })).role).toBe(
      'ADMIN',
    );
    expect(
      (
        await mutate(sa, {
          method: 'PATCH',
          url: `/api/users/${engineer.id}`,
          payload: { expectedVersion: engineer.version, role: 'ADMIN' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: engineer.id } })).role).toBe(
      'RESPONSIBLE_ENGINEER',
    );
    expect(
      JSON.stringify(
        (
          await inject({
            method: 'GET',
            url: '/api/auth/me',
            cookies: { [SESSION_COOKIE_NAME]: sa.cookie },
          })
        ).json(),
      ),
    ).not.toMatch(/passwordHash|sessionVersion/);

    const audits = await prisma.auditLog.findMany({
      where: { action: { in: ['ADMIN_GRANTED', 'ADMIN_REVOKED'] }, entityId: sgr.id },
    });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toMatch(/passwordHash|csrfToken|sgr_session/);

    const keepAdmin = await prisma.user.findFirstOrThrow({
      where: { role: 'ADMIN', status: 'ACTIVE' },
    });
    const others = await prisma.user.findMany({
      where: { role: 'ADMIN', status: 'ACTIVE', id: { not: keepAdmin.id } },
      select: { id: true },
    });
    const now = new Date();
    if (others.length > 0) {
      await prisma.user.updateMany({
        where: { id: { in: others.map((row) => row.id) } },
        data: { status: 'ARCHIVED', archivedAt: now },
      });
    }
    try {
      const lastFail = await mutate(sa, {
        method: 'DELETE',
        url: `/api/super-admin/admins/${keepAdmin.id}`,
        payload: { expectedVersion: keepAdmin.version },
      });
      expect(lastFail.statusCode).toBe(409);
      expect((lastFail.json() as { message: string }).message).toBe(
        'Нельзя снять права последнего администратора',
      );
      const concurrent = await Promise.all([
        mutate(sa, {
          method: 'DELETE',
          url: `/api/super-admin/admins/${keepAdmin.id}`,
          payload: { expectedVersion: keepAdmin.version },
        }),
        mutate(sa, {
          method: 'DELETE',
          url: `/api/super-admin/admins/${keepAdmin.id}`,
          payload: { expectedVersion: keepAdmin.version },
        }),
      ]);
      expect(concurrent.every((item) => item.statusCode === 409)).toBe(true);
      expect(
        await prisma.user.count({ where: { id: keepAdmin.id, role: 'ADMIN', status: 'ACTIVE' } }),
      ).toBe(1);
    } finally {
      if (others.length > 0) {
        await prisma.user.updateMany({
          where: { id: { in: others.map((row) => row.id) } },
          data: { status: 'ACTIVE', archivedAt: null },
        });
      }
    }
  });
});
