import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { Pool } from 'pg';
import { postgresUrlWithoutSchema } from '../src/database-url';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile, override: true });

const GROUP_ROLES = ['sgr_owner', 'sgr_app', 'sgr_auth', 'sgr_worker'] as const;
const PRODUCTION_CONFIRM = 'I_UNDERSTAND_PRODUCTION_DB_ROLES';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for role provisioning`);
  }
  return value;
}

function urlUser(url: string): string {
  return decodeURIComponent(new URL(url).username);
}

function urlPassword(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

async function assertAdmin(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean }>(
    `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`,
  );
  if (!rows[0]?.rolsuper) {
    throw new Error('Role provisioning must run as a PostgreSQL superuser (POSTGRES_ADMIN_URL)');
  }
}

async function ensureGroup(
  pool: Pool,
  name: (typeof GROUP_ROLES)[number],
  options: { bypassrls: boolean; login: boolean },
): Promise<void> {
  const { rows } = await pool.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
  }>(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
     FROM pg_roles WHERE rolname = $1`,
    [name],
  );
  const bypass = options.bypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS';
  const login = options.login ? 'LOGIN' : 'NOLOGIN';
  if (rows.length === 0) {
    await pool.query(
      `CREATE ROLE ${name} NOSUPERUSER ${bypass} NOCREATEDB NOCREATEROLE ${login} NOREPLICATION`,
    );
    return;
  }
  const role = rows[0];
  if (!role) {
    throw new Error(`Role ${name} lookup failed`);
  }
  if (role.rolsuper || role.rolcreatedb || role.rolcreaterole) {
    throw new Error(`Refusing to continue: ${name} has elevated attributes`);
  }
  if (name !== 'sgr_owner' && role.rolbypassrls) {
    throw new Error(`Refusing to continue: runtime role ${name} has BYPASSRLS`);
  }
  await pool.query(
    `ALTER ROLE ${name} NOSUPERUSER ${bypass} NOCREATEDB NOCREATEROLE ${login} NOREPLICATION`,
  );
}

async function ensureLogin(
  pool: Pool,
  name: string,
  password: string,
  group: 'sgr_app' | 'sgr_auth' | 'sgr_worker' | 'sgr_owner',
): Promise<void> {
  if (GROUP_ROLES.includes(name as (typeof GROUP_ROLES)[number])) {
    throw new Error(`Login role ${name} must not reuse a NOLOGIN group name`);
  }
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
    [name],
  );
  const inherit = 'INHERIT';
  const kind = rows.length === 0 ? 'CREATE' : 'ALTER';
  if (rows.length > 0) {
    const role = rows[0];
    if (role?.rolsuper || role?.rolbypassrls) {
      throw new Error(`Refusing to continue: login role ${name} is superuser or BYPASSRLS`);
    }
  }
  const built = await pool.query<{ cmd: string }>(`SELECT format($1, $2::text, $3::text) AS cmd`, [
    `${kind} ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE ${inherit} PASSWORD %L`,
    name,
    password,
  ]);
  const cmd = built.rows[0]?.cmd;
  if (!cmd) {
    throw new Error(`Failed to build ${kind} ROLE statement`);
  }
  await pool.query(cmd);
  await pool.query(`GRANT ${group} TO ${name}`);
}

async function forbidCrossMembership(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ member: string; grantor: string }>(`
    SELECT r.rolname AS member, g.rolname AS grantor
    FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.member
    JOIN pg_roles g ON g.oid = m.roleid
    WHERE g.rolname IN ('sgr_owner', 'sgr_app', 'sgr_auth', 'sgr_worker')
       OR r.rolname IN ('sgr_owner', 'sgr_app', 'sgr_auth', 'sgr_worker')
  `);
  for (const row of rows) {
    const allowed =
      (row.grantor === 'sgr_owner' &&
        row.member !== 'sgr_app' &&
        row.member !== 'sgr_auth' &&
        row.member !== 'sgr_worker') ||
      (row.grantor === 'sgr_app' &&
        row.member !== 'sgr_owner' &&
        row.member !== 'sgr_auth' &&
        row.member !== 'sgr_worker') ||
      (row.grantor === 'sgr_auth' &&
        row.member !== 'sgr_owner' &&
        row.member !== 'sgr_app' &&
        row.member !== 'sgr_worker') ||
      (row.grantor === 'sgr_worker' &&
        row.member !== 'sgr_owner' &&
        row.member !== 'sgr_app' &&
        row.member !== 'sgr_auth');
    if (!allowed) {
      throw new Error(`Illegal membership ${row.member} → ${row.grantor}`);
    }
  }
}

async function reassignPublicToOwner(pool: Pool): Promise<void> {
  await pool.query(`
    DO $$
    DECLARE
      r record;
    BEGIN
      FOR r IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S', 'v', 'm', 'p')
          AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = 'sgr_owner')
      LOOP
        EXECUTE format('ALTER TABLE public.%I OWNER TO sgr_owner', r.relname);
      END LOOP;
      FOR r IN
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            JOIN pg_extension e ON e.oid = d.refobjid
            WHERE d.objid = p.oid AND d.deptype = 'e'
          )
      LOOP
        EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO sgr_owner', r.proname, r.args);
      END LOOP;
      ALTER SCHEMA public OWNER TO sgr_owner;
      FOR r IN
        SELECT t.typname
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typtype = 'e'
          AND t.typowner <> (SELECT oid FROM pg_roles WHERE rolname = 'sgr_owner')
      LOOP
        EXECUTE format('ALTER TYPE public.%I OWNER TO sgr_owner', r.typname);
      END LOOP;
    END
    $$;
  `);
}

async function upsertSecret(pool: Pool, secret: string): Promise<void> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'sgr_rls_secrets'
     ) AS exists`,
  );
  if (!rows[0]?.exists) {
    return;
  }
  const active = await pool.query(
    `SELECT 1 FROM sgr_rls_secrets WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
  );
  if (active.rows.length === 0) {
    await pool.query(`INSERT INTO sgr_rls_secrets (secret) VALUES ($1)`, [secret]);
  }
}

async function main(): Promise<void> {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.CONFIRM_PRODUCTION_DB_ROLES !== PRODUCTION_CONFIRM
  ) {
    throw new Error(
      `Refusing production role provisioning without CONFIRM_PRODUCTION_DB_ROLES=${PRODUCTION_CONFIRM}`,
    );
  }
  const adminUrl = process.env.POSTGRES_ADMIN_URL ?? '';
  if (!adminUrl) {
    throw new Error('POSTGRES_ADMIN_URL is required (bootstrap superuser, never a runtime URL)');
  }
  const appUrl = requiredEnv('DATABASE_URL');
  const authUrl = requiredEnv('AUTH_DATABASE_URL');
  const workerUrl = requiredEnv('WORKER_DATABASE_URL');
  const migratorUrl = requiredEnv('MIGRATION_DATABASE_URL');
  const secret = requiredEnv('RLS_CONTEXT_SECRET');
  if (secret.length < 32) {
    throw new Error('RLS_CONTEXT_SECRET must be at least 32 characters');
  }

  const appUser = urlUser(appUrl);
  const authUser = urlUser(authUrl);
  const workerUser = urlUser(workerUrl);
  const migratorUser = urlUser(migratorUrl);
  if (new Set([appUser, authUser, workerUser, migratorUser]).size !== 4) {
    throw new Error('App, auth, worker, and migrator database users must be distinct');
  }
  if (
    [appUser, authUser, workerUser].includes('sgr_registry') ||
    [appUser, authUser, workerUser].includes('sgr_owner')
  ) {
    throw new Error('Runtime URLs must not use bootstrap or owner roles');
  }

  const admin = new Pool({ connectionString: postgresUrlWithoutSchema(adminUrl) });
  try {
    await assertAdmin(admin);
    await ensureGroup(admin, 'sgr_owner', { bypassrls: true, login: false });
    await ensureGroup(admin, 'sgr_app', { bypassrls: false, login: false });
    await ensureGroup(admin, 'sgr_auth', { bypassrls: false, login: false });
    await ensureGroup(admin, 'sgr_worker', { bypassrls: false, login: false });
    await ensureLogin(admin, appUser, urlPassword(appUrl), 'sgr_app');
    await ensureLogin(admin, authUser, urlPassword(authUrl), 'sgr_auth');
    await ensureLogin(admin, workerUser, urlPassword(workerUrl), 'sgr_worker');
    await ensureLogin(admin, migratorUser, urlPassword(migratorUrl), 'sgr_owner');
    await forbidCrossMembership(admin);

    const databases = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datallowconn AND datname NOT IN ('template0', 'template1', 'postgres')`,
    );
    const targets = databases.rows
      .map((row) => row.datname)
      .filter((name) => name === 'sgr_registry' || name.endsWith('_test'));

    for (const datname of targets) {
      const dbUrl = new URL(adminUrl);
      dbUrl.pathname = `/${datname}`;
      const db = new Pool({ connectionString: postgresUrlWithoutSchema(dbUrl.toString()) });
      try {
        await db.query(
          `GRANT CONNECT ON DATABASE "${datname}" TO sgr_app, sgr_auth, sgr_worker, sgr_owner`,
        );
        await db.query(
          `GRANT CONNECT ON DATABASE "${datname}" TO ${migratorUser}, ${appUser}, ${authUser}, ${workerUser}`,
        );
        await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await reassignPublicToOwner(db);
        await upsertSecret(db, secret);
      } finally {
        await db.end();
      }
    }

    console.log(`Provisioned database roles. Secret fingerprint ${fingerprint(secret)}.`);
  } finally {
    await admin.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Role provisioning failed';
  console.error(message);
  process.exit(1);
});
