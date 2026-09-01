import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';
import { Pool } from 'pg';
import { postgresUrlWithoutSchema, withDatabaseName } from '../src/database-url';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile, override: true });

const ISOLATED_DB = 'sgr_isolation_hardening_test';
const SENTINEL_HASH = 'argon2-isolated-hash-must-not-change';
const SENTINEL_USER = '11111111-1111-4111-8111-111111111111';
const EXTRA_MIGRATIONS = [
  '20260901150000_user_credentials',
  '20260901150100_sla_clock_write_scope',
  '20260901150200_user_credentials_definer',
  '20260901160000_active_super_admin_catalog',
];
const migrationsDir = resolve(repoRoot, 'packages/database/prisma/migrations');
const stashDir = resolve(repoRoot, 'tmp/hidden-isolation-migrations');

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function hideForwardMigrations(): void {
  mkdirSync(stashDir, { recursive: true });
  for (const name of EXTRA_MIGRATIONS) {
    const from = resolve(migrationsDir, name);
    const to = resolve(stashDir, name);
    if (!existsSync(from)) {
      throw new Error(`missing migration ${name}`);
    }
    if (existsSync(to)) {
      rmSync(to, { recursive: true, force: true });
    }
    renameSync(from, to);
  }
}

function restoreForwardMigrations(): void {
  for (const name of EXTRA_MIGRATIONS) {
    const from = resolve(migrationsDir, name);
    const to = resolve(stashDir, name);
    if (existsSync(to) && !existsSync(from)) {
      renameSync(to, from);
    }
  }
}

function migrate(env: NodeJS.ProcessEnv, label: string): string {
  const result = spawnSync('pnpm', ['db:migrate'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) {
    throw new Error(`${label} failed`);
  }
  return output;
}

function assertNoPending(output: string, label: string): void {
  if (!output.includes('No pending migrations')) {
    throw new Error(`${label}: pending migrations remain`);
  }
}

async function main(): Promise<void> {
  restoreForwardMigrations();
  const adminUrl = required('POSTGRES_ADMIN_URL');
  const migratorUrl = required('MIGRATION_DATABASE_URL');
  const appUrl = required('DATABASE_URL');
  const authUrl = required('AUTH_DATABASE_URL');
  const workerUrl = required('WORKER_DATABASE_URL');
  const admin = new Pool({ connectionString: postgresUrlWithoutSchema(adminUrl) });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${ISOLATED_DB}`);
    await admin.query(`CREATE DATABASE ${ISOLATED_DB}`);
  } finally {
    await admin.end();
  }

  const isolatedAdmin = new URL(adminUrl);
  isolatedAdmin.pathname = `/${ISOLATED_DB}`;
  const db = new Pool({ connectionString: postgresUrlWithoutSchema(isolatedAdmin.toString()) });
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  } finally {
    await db.end();
  }

  const provision = spawnSync('pnpm', ['db:roles:provision'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (provision.status !== 0) {
    throw new Error('Role provisioning failed');
  }

  const migrateEnv = {
    ...process.env,
    MIGRATION_DATABASE_URL: withDatabaseName(migratorUrl, ISOLATED_DB),
  };

  try {
    hideForwardMigrations();
    migrate(migrateEnv, 'Isolated migrate before credential split');
    const preload = new Pool({
      connectionString: postgresUrlWithoutSchema(withDatabaseName(adminUrl, ISOLATED_DB)),
    });
    try {
      await preload.query(
        `
        INSERT INTO users (id, "fullName", email, role, "passwordHash", "createdAt", "updatedAt")
        VALUES ($1, 'Isolated User', 'isolated.hash@example.sgr.local', 'SGR_MANAGER', $2, now(), now())
      `,
        [SENTINEL_USER, SENTINEL_HASH],
      );
    } finally {
      await preload.end();
    }
  } finally {
    restoreForwardMigrations();
  }

  migrate(migrateEnv, 'Isolated migrate credential split');
  const pending = migrate(migrateEnv, 'Isolated migrate redeploy');
  assertNoPending(pending, 'Isolated migrate redeploy');

  const verify = new Pool({
    connectionString: postgresUrlWithoutSchema(withDatabaseName(adminUrl, ISOLATED_DB)),
  });
  const app = new Pool({
    connectionString: postgresUrlWithoutSchema(withDatabaseName(appUrl, ISOLATED_DB)),
  });
  const auth = new Pool({
    connectionString: postgresUrlWithoutSchema(withDatabaseName(authUrl, ISOLATED_DB)),
  });
  const worker = new Pool({
    connectionString: postgresUrlWithoutSchema(withDatabaseName(workerUrl, ISOLATED_DB)),
  });
  try {
    const columns = await verify.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name IN ('passwordHash', 'passwordChangedAt')
    `);
    if (columns.rows.length !== 0) {
      throw new Error('users still exposes credential columns');
    }
    const copied = await verify.query<{ ok: number }>(
      `
      SELECT 1 AS ok FROM user_credentials
      WHERE "userId" = $1 AND "passwordHash" = $2
    `,
      [SENTINEL_USER, SENTINEL_HASH],
    );
    if (copied.rows.length !== 1) {
      throw new Error('password hash was rewritten or not copied');
    }
    const owners = await verify.query<{ relname: string; rolname: string }>(`
      SELECT c.relname, r.rolname
      FROM pg_class c
      JOIN pg_roles r ON r.oid = c.relowner
      WHERE c.relname IN ('user_credentials', 'sla_clocks', 'users')
    `);
    if (owners.rows.some((row) => row.rolname !== 'sgr_owner')) {
      throw new Error('unexpected table owner');
    }
    const rls = await verify.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN ('user_credentials', 'sla_clocks')
    `);
    if (rls.rows.some((row) => !row.relrowsecurity || !row.relforcerowsecurity)) {
      throw new Error('FORCE RLS missing');
    }
    await expectDenied(app, 'SELECT "passwordHash" FROM user_credentials');
    await expectDenied(worker, 'SELECT "passwordHash" FROM user_credentials');
    await expectDenied(app, 'SELECT * FROM user_credentials');
    await expectDenied(worker, 'SELECT * FROM user_credentials');
    const authRead = await auth.query(
      `SELECT 1 AS ok FROM user_credentials WHERE "userId" = $1 AND "passwordHash" = $2`,
      [SENTINEL_USER, SENTINEL_HASH],
    );
    if (authRead.rows.length !== 1) {
      throw new Error('sgr_auth cannot read unchanged hash');
    }
    await expectDenied(
      app,
      `INSERT INTO sla_clocks (id, "defectItemId", kind, state) SELECT gen_random_uuid(), gen_random_uuid(), 'GENERAL', 'NORMAL'`,
    );
    await expectDenied(auth, 'SELECT * FROM sla_clocks');
    await expectDenied(auth, 'SELECT * FROM acts');
    await expectDenied(worker, "SELECT public.sgr_upsert_user_credentials(gen_random_uuid(), 'x')");
    console.log('Isolated Redis/database isolation migration verification passed.');
  } finally {
    await verify.end();
    await app.end();
    await auth.end();
    await worker.end();
  }

  const drop = new Pool({ connectionString: postgresUrlWithoutSchema(adminUrl) });
  try {
    await drop.query(`DROP DATABASE IF EXISTS ${ISOLATED_DB}`);
  } finally {
    await drop.end();
  }
}

async function expectDenied(pool: Pool, query: string): Promise<void> {
  try {
    await pool.query(query);
    throw new Error(`expected permission denied: ${query.split(' ')[0]}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('expected permission denied')) {
      throw error;
    }
    if (!/permission denied|42501|must be owner/i.test(message)) {
      throw new Error(`unexpected error for isolated grant check: ${message}`, { cause: error });
    }
  }
}

void main().catch(async (error: unknown) => {
  restoreForwardMigrations();
  console.error(
    error instanceof Error ? error.message : 'Isolated isolation-hardening verification failed',
  );
  try {
    const adminUrl = process.env.POSTGRES_ADMIN_URL;
    if (adminUrl) {
      const drop = new Pool({ connectionString: postgresUrlWithoutSchema(adminUrl) });
      try {
        await drop.query(`DROP DATABASE IF EXISTS ${ISOLATED_DB}`);
      } finally {
        await drop.end();
      }
    }
  } catch {
    // keep the original failure
  }
  process.exit(1);
});
