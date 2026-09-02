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

const ISOLATED_DB = 'sgr_objects_directory_isolated_test';

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
    encoding: 'utf8',
    env: migrateEnv,
  });
  if (second.status !== 0) {
    throw new Error('Isolated migrate redeploy failed');
  }
  if (!second.stdout?.includes('No pending migrations')) {
    throw new Error('Pending migrations remain after second deploy');
  }

  const verify = new Pool({
    connectionString: postgresUrlWithoutSchema(withDatabaseName(adminUrl, ISOLATED_DB)),
  });
  try {
    const nullable = await verify.query<{ is_nullable: string }>(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'property_objects' AND column_name = 'address'
    `);
    if (nullable.rows[0]?.is_nullable !== 'YES') {
      throw new Error('property_objects.address must be nullable');
    }

    const columns = await verify.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'property_objects'
        AND column_name IN (
          'sortOrder',
          'sourceResponsibleEngineerName',
          'sourceSystem',
          'sourceRow',
          'sourceImportKey'
        )
    `);
    if (columns.rows.length !== 5) {
      throw new Error('directory columns missing on property_objects');
    }

    const objectsSelect = await verify.query<{ qual: string }>(`
      SELECT pg_get_expr(polqual, polrelid) AS qual
      FROM pg_policy
      WHERE polname = 'objects_select'
        AND polrelid = 'public.property_objects'::regclass
    `);
    if (!objectsSelect.rows[0]?.qual.includes('sgr_is_business_user')) {
      throw new Error('objects_select policy was rewritten unexpectedly');
    }

    const actsSelect = await verify.query<{ qual: string }>(`
      SELECT pg_get_expr(polqual, polrelid) AS qual
      FROM pg_policy
      WHERE polname = 'acts_select'
        AND polrelid = 'public.acts'::regclass
    `);
    if (!actsSelect.rows[0]?.qual.includes('sgr_app_visible_object')) {
      throw new Error('acts_select policy changed unexpectedly');
    }

    await verify.query(`
      INSERT INTO property_objects (id, name, address, "sortOrder", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), 'Isolated empty address', NULL, 1, now(), now())
    `);
    console.log('Isolated property objects directory migration verification passed.');
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
    error instanceof Error ? error.message : 'Isolated objects directory verification failed',
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
    /* ignore cleanup errors */
  }
  process.exit(1);
});
