import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import Redis from 'ioredis';
import {
  createOwnerPrismaClient,
  createPrismaClient,
  ensureTestSuperAdmin,
  listActiveSuperAdmins,
  postgresUrlWithoutSchema,
  provisionSuperAdmin,
  revokeUserRedisSessions,
  SuperAdminProvisionError,
} from '../../src/index';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';

const appUrl = process.env.DATABASE_URL ?? '';
const workerUrl = process.env.WORKER_DATABASE_URL ?? '';
const migratorUrl = process.env.MIGRATION_DATABASE_URL ?? '';
const redisUrl = process.env.REDIS_URL ?? '';

assertSafeTestDatabaseUrl(appUrl);
assertSafeTestDatabaseUrl(workerUrl);
assertSafeTestDatabaseUrl(migratorUrl);

const owner = createOwnerPrismaClient(migratorUrl);
const appPrisma = createPrismaClient(appUrl);
const MARKER = `prov-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'treefrog1';

async function sql(
  url: string,
  query: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const pool = new Pool({ connectionString: postgresUrlWithoutSchema(url), max: 1 });
  try {
    const result = await pool.query(query, params);
    return { rows: result.rows as Record<string, unknown>[] };
  } catch (error) {
    return { rows: [], error: error instanceof Error ? error.message : 'query failed' };
  } finally {
    await pool.end();
  }
}

describe('atomic SUPER_ADMIN provisioning', () => {
  beforeAll(async () => {
    expect(migratorUrl).toContain('_test');
  });

  afterAll(async () => {
    await owner.user.deleteMany({ where: { email: { startsWith: `${MARKER}.` } } });
    await owner.$disconnect();
    await appPrisma.$disconnect();
  });

  beforeEach(async () => {
    await owner.user.updateMany({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
  });

  it('validates the password before the first database write', async () => {
    const email = `${MARKER}.before-write@example.sgr.local`;
    const before = await owner.user.count();
    await expect(
      provisionSuperAdmin({
        owner,
        email,
        fullName: 'До записи',
        password: 'short',
      }),
    ).rejects.toThrow();
    expect(await owner.user.count()).toBe(before);
    expect(await owner.user.findUnique({ where: { email } })).toBeNull();
  });

  it('rolls back after user creation if a later step fails', async () => {
    const email = `${MARKER}.after-user@example.sgr.local`;
    await expect(
      provisionSuperAdmin({
        owner,
        email,
        fullName: 'После пользователя',
        password: PASSWORD,
        failAfter: 'user',
      }),
    ).rejects.toBeInstanceOf(SuperAdminProvisionError);
    expect(await owner.user.findUnique({ where: { email } })).toBeNull();
    expect(await listActiveSuperAdmins(owner)).toEqual([]);
  });

  it('rolls back after credentials if a later step fails', async () => {
    const email = `${MARKER}.after-creds@example.sgr.local`;
    await expect(
      provisionSuperAdmin({
        owner,
        email,
        fullName: 'После credentials',
        password: PASSWORD,
        failAfter: 'credentials',
      }),
    ).rejects.toBeInstanceOf(SuperAdminProvisionError);
    const leftover = await owner.user.findUnique({
      where: { email },
      include: { credentials: true },
    });
    expect(leftover).toBeNull();
  });

  it('rolls back replacement when AuditLog fails', async () => {
    const previousEmail = `${MARKER}.keep@example.sgr.local`;
    const nextEmail = `${MARKER}.next@example.sgr.local`;
    const previous = await provisionSuperAdmin({
      owner,
      email: previousEmail,
      fullName: 'Тест Прежний',
      password: PASSWORD,
    });
    await expect(
      provisionSuperAdmin({
        owner,
        email: nextEmail,
        fullName: 'Тест Новый',
        password: PASSWORD,
        replace: true,
        replaceConfirmEmail: previousEmail,
        failAfter: 'audit',
      }),
    ).rejects.toBeInstanceOf(SuperAdminProvisionError);
    const still = await owner.user.findUniqueOrThrow({ where: { id: previous.id } });
    expect(still.status).toBe('ACTIVE');
    expect(still.email).toBe(previousEmail);
    expect(await owner.user.findUnique({ where: { email: nextEmail } })).toBeNull();
    const catalog = await listActiveSuperAdmins(owner);
    expect(catalog).toEqual([{ email: previousEmail, status: 'ACTIVE' }]);
  });

  it('archives only the confirmed SUPER_ADMIN on replace', async () => {
    const previousEmail = `${MARKER}.old@example.sgr.local`;
    const nextEmail = `${MARKER}.new@example.sgr.local`;
    const previous = await provisionSuperAdmin({
      owner,
      email: previousEmail,
      fullName: 'Тест Старый',
      password: PASSWORD,
    });
    const replaced = await provisionSuperAdmin({
      owner,
      email: nextEmail,
      fullName: 'Тест Новый',
      password: PASSWORD,
      replace: true,
      replaceConfirmEmail: previousEmail,
    });
    expect(replaced.replacedEmail).toBe(previousEmail);
    expect((await owner.user.findUniqueOrThrow({ where: { id: previous.id } })).status).toBe(
      'ARCHIVED',
    );
    const catalog = await listActiveSuperAdmins(owner);
    expect(catalog).toEqual([{ email: nextEmail, status: 'ACTIVE' }]);
  });

  it('refuses replace when the confirmation email does not match', async () => {
    const previousEmail = `${MARKER}.confirm@example.sgr.local`;
    await provisionSuperAdmin({
      owner,
      email: previousEmail,
      fullName: 'Тест Ожидаемый',
      password: PASSWORD,
    });
    await expect(
      provisionSuperAdmin({
        owner,
        email: `${MARKER}.other@example.sgr.local`,
        fullName: 'Тест Другой',
        password: PASSWORD,
        replace: true,
        replaceConfirmEmail: `${MARKER}.wrong@example.sgr.local`,
      }),
    ).rejects.toThrow(/confirmation/);
    const catalog = await listActiveSuperAdmins(owner);
    expect(catalog).toEqual([{ email: previousEmail, status: 'ACTIVE' }]);
  });

  it('does not create two active SUPER_ADMIN rows under concurrency', async () => {
    const first = `${MARKER}.c1@example.sgr.local`;
    const second = `${MARKER}.c2@example.sgr.local`;
    const secondOwner = createOwnerPrismaClient(migratorUrl);
    try {
      const results = await Promise.allSettled([
        provisionSuperAdmin({
          owner,
          email: first,
          fullName: 'Тест Первый',
          password: PASSWORD,
        }),
        provisionSuperAdmin({
          owner: secondOwner,
          email: second,
          fullName: 'Тест Второй',
          password: PASSWORD,
        }),
      ]);
      const fulfilled = results.filter((item) => item.status === 'fulfilled');
      const rejected = results.filter((item) => item.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const catalog = await listActiveSuperAdmins(owner);
      expect(catalog).toHaveLength(1);
    } finally {
      await secondOwner.$disconnect();
    }
  });

  it('revokes Redis sessions of the replaced user only after commit', async () => {
    const previousEmail = `${MARKER}.sess@example.sgr.local`;
    const nextEmail = `${MARKER}.sess-next@example.sgr.local`;
    const previous = await provisionSuperAdmin({
      owner,
      email: previousEmail,
      fullName: 'Тест Сессия',
      password: PASSWORD,
    });
    const prefix = 'sgr-test';
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
    const sessionHash = `itest-${randomUUID()}`;
    try {
      await redis.connect();
      await redis.set(`${prefix}:sess:${sessionHash}`, '1', 'EX', 60);
      await redis.sadd(`${prefix}:user-sess:${previous.id}`, sessionHash);
      await expect(
        provisionSuperAdmin({
          owner,
          email: nextEmail,
          fullName: 'После сессии',
          password: PASSWORD,
          replace: true,
          replaceConfirmEmail: previousEmail,
          failAfter: 'audit',
        }),
      ).rejects.toBeInstanceOf(SuperAdminProvisionError);
      expect(await redis.get(`${prefix}:sess:${sessionHash}`)).toBe('1');
      await provisionSuperAdmin({
        owner,
        email: nextEmail,
        fullName: 'После сессии',
        password: PASSWORD,
        replace: true,
        replaceConfirmEmail: previousEmail,
      });
      await revokeUserRedisSessions({ redisUrl, prefix, userId: previous.id });
      expect(await redis.get(`${prefix}:sess:${sessionHash}`)).toBeNull();
    } finally {
      await redis.del(`${prefix}:sess:${sessionHash}`, `${prefix}:user-sess:${previous.id}`);
      redis.disconnect();
    }
  });
});

describe('RLS-safe SUPER_ADMIN catalog', () => {
  afterAll(async () => {
    await owner.user.deleteMany({ where: { email: { startsWith: `${MARKER}.rls.` } } });
  });

  it('finds the active SUPER_ADMIN when runtime RLS would hide the row', async () => {
    await owner.user.updateMany({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    const email = `${MARKER}.rls.sa@example.sgr.local`;
    await provisionSuperAdmin({
      owner,
      email,
      fullName: 'Тест Каталог',
      password: PASSWORD,
    });

    const migrator = new Pool({ connectionString: postgresUrlWithoutSchema(migratorUrl), max: 1 });
    try {
      const hidden = await migrator.query(
        `SELECT email FROM users WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE'`,
      );
      expect(hidden.rows).toHaveLength(0);
      const catalog = await migrator.query<{ email: string; status: string }>(
        `SELECT email, status FROM public.sgr_active_super_admins()`,
      );
      expect(catalog.rows).toEqual([{ email, status: 'ACTIVE' }]);
      expect(JSON.stringify(catalog.rows)).not.toMatch(/passwordHash/);
      await migrator.query('SET ROLE sgr_owner');
      const asOwner = await migrator.query<{ email: string }>(
        `SELECT email FROM public.sgr_active_super_admins()`,
      );
      expect(asOwner.rows.some((row) => row.email === email)).toBe(true);
      await migrator.query('RESET ROLE');
      const afterReset = await migrator.query<{ email: string }>(
        `SELECT email FROM public.sgr_active_super_admins()`,
      );
      expect(afterReset.rows.some((row) => row.email === email)).toBe(true);
    } finally {
      await migrator.end();
    }

    const appDenied = await sql(appUrl, `SELECT email FROM public.sgr_active_super_admins()`);
    expect(appDenied.error).toBeTruthy();
    expect(JSON.stringify(appDenied)).not.toMatch(/passwordHash/);
    const workerDenied = await sql(workerUrl, `SELECT email FROM public.sgr_active_super_admins()`);
    expect(workerDenied.error).toBeTruthy();
    const appHash = await sql(appUrl, `SELECT "passwordHash" FROM user_credentials LIMIT 1`);
    expect(appHash.error).toBeTruthy();
    const workerHash = await sql(workerUrl, `SELECT "passwordHash" FROM user_credentials LIMIT 1`);
    expect(workerHash.error).toBeTruthy();
    const runtimeUsers = await appPrisma.user.findMany({
      where: { email },
    });
    expect(runtimeUsers).toHaveLength(0);
  });
});

describe('E2E fixture guard', () => {
  it('refuses ensureTestSuperAdmin against development and integration databases', async () => {
    const base = {
      NODE_ENV: 'development',
      SGR_E2E_TARGET_CONFIRM: 'sgr_registry_e2e',
      REDIS_URL: 'redis://sgr_api:x@127.0.0.1:6379/14',
      REDIS_KEY_PREFIX: 'sgr-e2e',
      S3_BUCKET: 'sgr-attachments-e2e',
    };
    await expect(
      ensureTestSuperAdmin({
        owner,
        password: PASSWORD,
        env: {
          ...base,
          DATABASE_URL: 'postgresql://sgr_app_user:x@127.0.0.1:5432/sgr_registry',
          AUTH_DATABASE_URL: 'postgresql://sgr_auth_user:x@127.0.0.1:5432/sgr_registry',
          WORKER_DATABASE_URL: 'postgresql://sgr_worker_user:x@127.0.0.1:5432/sgr_registry',
          MIGRATION_DATABASE_URL: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry',
        },
      }),
    ).rejects.toThrow(/sgr_registry/);
    await expect(
      ensureTestSuperAdmin({
        owner,
        password: PASSWORD,
        env: {
          ...base,
          DATABASE_URL: 'postgresql://sgr_app_user:x@127.0.0.1:5432/sgr_registry_test',
          AUTH_DATABASE_URL: 'postgresql://sgr_auth_user:x@127.0.0.1:5432/sgr_registry_test',
          WORKER_DATABASE_URL: 'postgresql://sgr_worker_user:x@127.0.0.1:5432/sgr_registry_test',
          MIGRATION_DATABASE_URL: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry_test',
        },
      }),
    ).rejects.toThrow(/sgr_registry_test/);
  });
});
