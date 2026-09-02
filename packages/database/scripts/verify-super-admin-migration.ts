import { existsSync } from 'node:fs';
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

const ISOLATED_DB = 'sgr_super_admin_isolated_test';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const adminUrl = required('POSTGRES_ADMIN_URL');
  const migratorUrl = required('MIGRATION_DATABASE_URL');
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
  const first = spawnSync('pnpm', ['db:migrate'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: migrateEnv,
  });
  if (first.status !== 0) {
    throw new Error('Isolated migrate deploy failed');
  }
  const second = spawnSync('pnpm', ['db:migrate'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: migrateEnv,
  });
  if (second.status !== 0) {
    throw new Error('Isolated migrate redeploy failed');
  }

  const verify = new Pool({
    connectionString: postgresUrlWithoutSchema(withDatabaseName(adminUrl, ISOLATED_DB)),
  });
  try {
    const pending = spawnSync('pnpm', ['db:migrate'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: migrateEnv,
    });
    if (!pending.stdout?.includes('No pending migrations') && pending.status !== 0) {
      throw new Error(pending.stderr || 'Pending migrations remain');
    }
    const labels = await verify.query<{ enumlabel: string }>(`
      SELECT e.enumlabel
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'UserRole'
      ORDER BY e.enumsortorder
    `);
    if (!labels.rows.some((row) => row.enumlabel === 'SUPER_ADMIN')) {
      throw new Error('SUPER_ADMIN enum value missing');
    }
    if (!labels.rows.some((row) => row.enumlabel === 'PENDING_ROLE')) {
      throw new Error('PENDING_ROLE enum value missing');
    }
    if (!labels.rows.some((row) => row.enumlabel === 'UNASSIGNED')) {
      throw new Error('UNASSIGNED enum value missing');
    }
    const column = await verify.query<{ data_type: string }>(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'roleBeforeAdmin'
    `);
    if (column.rows.length !== 1) {
      throw new Error('roleBeforeAdmin column missing');
    }
    await verify.query(`
      INSERT INTO users (id, "fullName", email, role, "createdAt", "updatedAt")
      VALUES (
        gen_random_uuid(),
        'Backfill Admin',
        'backfill.admin@example.sgr.local',
        'ADMIN',
        now(),
        now()
      )
    `);
    const backfill = await verify.query<{ role: string; previous: string | null }>(`
      SELECT role::text, "roleBeforeAdmin"::text AS previous
      FROM users WHERE email = 'backfill.admin@example.sgr.local'
    `);
    if (backfill.rows[0]?.role !== 'ADMIN' || backfill.rows[0]?.previous !== 'UNASSIGNED') {
      throw new Error('Existing ADMIN backfill to UNASSIGNED failed');
    }
    const chk = await verify.query(`
      SELECT 1 FROM pg_constraint WHERE conname = 'users_role_before_admin_chk'
    `);
    if (chk.rows.length !== 1) {
      throw new Error('users_role_before_admin_chk missing');
    }
    const fn = await verify.query(`
      SELECT 1 FROM pg_proc WHERE proname IN (
        'sgr_is_super_admin',
        'sgr_grant_admin',
        'sgr_super_admin_directory',
        'sgr_create_pending_user'
      )
    `);
    if (fn.rows.length < 4) {
      throw new Error('SUPER_ADMIN SQL functions missing');
    }
    console.log('Isolated SUPER_ADMIN migration verification passed.');
  } finally {
    await verify.end();
  }

  const drop = new Pool({ connectionString: postgresUrlWithoutSchema(adminUrl) });
  try {
    await drop.query(`DROP DATABASE IF EXISTS ${ISOLATED_DB}`);
  } finally {
    await drop.end();
  }
}

void main().catch(async (error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Isolated SUPER_ADMIN verification failed',
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
