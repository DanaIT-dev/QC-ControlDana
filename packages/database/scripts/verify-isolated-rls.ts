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

const ISOLATED_DB = 'sgr_rls_isolated_test';

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
    const owners = await verify.query<{ relname: string; owner: string }>(`
      SELECT c.relname, r.rolname AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname <> '_prisma_migrations'
    `);
    const wrongOwner = owners.rows.filter((row) => row.owner !== 'sgr_owner');
    if (wrongOwner.length > 0) {
      throw new Error(`Unexpected owners: ${wrongOwner.map((row) => row.relname).join(', ')}`);
    }
    const rls = await verify.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname IN ('acts', 'users', 'proposals', 'audit_logs', 'attachments')
    `);
    for (const row of rls.rows) {
      if (!row.relrowsecurity || !row.relforcerowsecurity) {
        throw new Error(`RLS not forced on ${row.relname}`);
      }
    }
    const attrs = await verify.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`
      SELECT rolname, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname IN ('sgr_app', 'sgr_auth', 'sgr_worker')
    `);
    for (const row of attrs.rows) {
      if (row.rolsuper || row.rolbypassrls) {
        throw new Error(`Runtime role ${row.rolname} is elevated`);
      }
    }
    console.log('Isolated RLS migration verification passed.');
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

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Isolated RLS verification failed');
  process.exit(1);
});
