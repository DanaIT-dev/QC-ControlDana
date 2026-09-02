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

const ISOLATED_DB = 'sgr_act_start_isolated_test';

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
    const labels = await verify.query<{ enumlabel: string }>(`
      SELECT e.enumlabel
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'ActStatus'
      ORDER BY e.enumsortorder
    `);
    const values = labels.rows.map((row) => row.enumlabel);
    if (!values.includes('NEW')) {
      throw new Error('NEW ActStatus enum value missing');
    }
    if (values.indexOf('NEW') >= values.indexOf('IN_PROGRESS')) {
      throw new Error('NEW must sort before IN_PROGRESS');
    }

    const columns = await verify.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'acts'
        AND column_name IN ('startedAt', 'startedById')
    `);
    if (columns.rows.length !== 2) {
      throw new Error('startedAt/startedById columns missing');
    }

    await verify.query(`
      INSERT INTO users (id, "fullName", email, role, "createdAt", "updatedAt")
      VALUES (
        gen_random_uuid(),
        'Fixture User',
        'act.start.fixture@example.sgr.local',
        'ADMIN',
        now(),
        now()
      )
    `);
    const object = await verify.query<{ id: string }>(`
      INSERT INTO property_objects (id, name, address, "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), 'Fixture object', 'Minsk', now(), now())
      RETURNING id
    `);
    const org = await verify.query<{ id: string }>(`
      INSERT INTO organizations (
        id, "officialName", "postalAddress", email, phone, "contactPerson", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid(),
        'Fixture org',
        'addr',
        'act.start.org@example.sgr.local',
        '1',
        'C',
        now(),
        now()
      )
      RETURNING id
    `);

    const existing = await verify.query<{
      status: string;
      started_at: Date | null;
      started_by: string | null;
    }>(
      `
      INSERT INTO acts (
        id, "officialNumber", "formCode", year, sequence, "objectId", "customerOrganizationId",
        "issuedOn", status, "startedAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid(),
        'С-1-2099-000001',
        'S1',
        2099,
        1,
        $1,
        $2,
        now(),
        'IN_PROGRESS',
        now() - interval '30 days',
        now() - interval '30 days',
        now()
      )
      RETURNING status::text, "startedAt" AS started_at, "startedById"::text AS started_by
    `,
      [object.rows[0]!.id, org.rows[0]!.id],
    );
    if (
      existing.rows[0]?.status !== 'IN_PROGRESS' ||
      !existing.rows[0]?.started_at ||
      existing.rows[0]?.started_by
    ) {
      throw new Error('Existing IN_PROGRESS fixture must keep status and null starter');
    }

    const completed = await verify.query<{ status: string }>(
      `
      INSERT INTO acts (
        id, "officialNumber", "formCode", year, sequence, "objectId", "customerOrganizationId",
        "issuedOn", status, "startedAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid(),
        'С-1-2099-000002',
        'S1',
        2099,
        2,
        $1,
        $2,
        now(),
        'COMPLETED',
        now() - interval '10 days',
        now() - interval '10 days',
        now()
      )
      RETURNING status::text
    `,
      [object.rows[0]!.id, org.rows[0]!.id],
    );
    if (completed.rows[0]?.status !== 'COMPLETED') {
      throw new Error('COMPLETED fixture lost its status');
    }

    const created = await verify.query<{ status: string; started_at: Date | null }>(
      `
      INSERT INTO acts (
        id, "officialNumber", "formCode", year, sequence, "objectId", "customerOrganizationId",
        "issuedOn", status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid(),
        'С-1-2099-000003',
        'S1',
        2099,
        3,
        $1,
        $2,
        now(),
        'NEW',
        now(),
        now()
      )
      RETURNING status::text, "startedAt" AS started_at
    `,
      [object.rows[0]!.id, org.rows[0]!.id],
    );
    if (created.rows[0]?.status !== 'NEW' || created.rows[0]?.started_at) {
      throw new Error('New act did not start as NEW');
    }

    let rejected = false;
    try {
      await verify.query(
        `
        INSERT INTO acts (
          id, "officialNumber", "formCode", year, sequence, "objectId", "customerOrganizationId",
          "issuedOn", status, "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid(),
          'С-1-2099-000004',
          'S1',
          2099,
          4,
          $1,
          $2,
          now(),
          'IN_PROGRESS',
          now(),
          now()
        )
      `,
        [object.rows[0]!.id, org.rows[0]!.id],
      );
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error('IN_PROGRESS without startedAt must be rejected');
    }

    const chk = await verify.query(`
      SELECT 1 FROM pg_constraint WHERE conname = 'acts_status_started_consistency'
    `);
    if (chk.rows.length !== 1) {
      throw new Error('acts_status_started_consistency missing');
    }
    const fn = await verify.query(`
      SELECT 1 FROM pg_proc WHERE proname = 'sgr_start_act'
    `);
    if (fn.rows.length !== 1) {
      throw new Error('sgr_start_act missing');
    }
    console.log('Isolated act start migration verification passed.');
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
  console.error(error instanceof Error ? error.message : 'Isolated act start verification failed');
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
