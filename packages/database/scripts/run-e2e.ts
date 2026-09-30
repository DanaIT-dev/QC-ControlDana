import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';
import { Pool } from 'pg';
import Redis from 'ioredis';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  applyE2eEnv,
  assertE2eDatabaseTarget,
  databaseNameOf,
  E2E_DATABASE_NAME,
  E2E_REDIS_KEY_PREFIX,
  E2E_S3_BUCKET,
  E2E_WEB_PORT,
  E2E_API_PORT,
  E2E_WORKER_HEALTH_PORT,
  postgresUrlWithoutSchema,
  TEST_SUPER_ADMIN_EMAIL,
  withDatabaseName,
} from '../src/index';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile, override: false });

type DevelopmentSnapshot = {
  usersCount: string;
  actsCount: string;
  objectsCount: string;
  orgsCount: string;
  defectTypesCount: string;
  auditCount: string;
  usersChecksum: string;
  superEmail: string | null;
  superStatus: string | null;
  superUpdated: string | null;
  redisKeyHash: string;
  redisKeyCount: number;
  minioKeyHash: string;
  minioKeyCount: number;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required for Playwright E2E`);
  }
  return value;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, label: string): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed`);
  }
}

async function pgSnapshot(
  adminUrl: string,
  databaseName: string,
): Promise<
  Omit<DevelopmentSnapshot, 'redisKeyHash' | 'redisKeyCount' | 'minioKeyHash' | 'minioKeyCount'>
> {
  if (databaseName !== 'sgr_registry') {
    throw new Error(`Refusing to snapshot unexpected development database "${databaseName}"`);
  }
  const pool = new Pool({
    connectionString: postgresUrlWithoutSchema(withDatabaseName(adminUrl, databaseName)),
    max: 1,
  });
  try {
    const result = await pool.query<{
      users_count: string;
      acts_count: string;
      objects_count: string;
      orgs_count: string;
      defect_types_count: string;
      audit_count: string;
      users_checksum: string | null;
      super_email: string | null;
      super_status: string | null;
      super_updated: string | null;
    }>(`
      SELECT
        (SELECT count(*)::text FROM users) AS users_count,
        (SELECT count(*)::text FROM acts) AS acts_count,
        (SELECT count(*)::text FROM property_objects) AS objects_count,
        (SELECT count(*)::text FROM organizations) AS orgs_count,
        (SELECT count(*)::text FROM defect_types) AS defect_types_count,
        (SELECT count(*)::text FROM audit_logs) AS audit_count,
        (SELECT md5(coalesce(string_agg(id::text || email || status::text || role::text || "updatedAt"::text, ',' ORDER BY id), '')) FROM users) AS users_checksum,
        (SELECT email FROM users WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE' LIMIT 1) AS super_email,
        (SELECT status::text FROM users WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE' LIMIT 1) AS super_status,
        (SELECT "updatedAt"::text FROM users WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE' LIMIT 1) AS super_updated
    `);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Development snapshot query returned no rows');
    }
    return {
      usersCount: row.users_count,
      actsCount: row.acts_count,
      objectsCount: row.objects_count,
      orgsCount: row.orgs_count,
      defectTypesCount: row.defect_types_count,
      auditCount: row.audit_count,
      usersChecksum: row.users_checksum ?? '',
      superEmail: row.super_email,
      superStatus: row.super_status,
      superUpdated: row.super_updated,
    };
  } finally {
    await pool.end();
  }
}

async function redisKeyFingerprint(
  redisUrl: string,
  prefix: string,
): Promise<{ hash: string; count: number }> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    keys.sort();
    return {
      count: keys.length,
      hash: createHash('sha256').update(keys.join('\n')).digest('hex'),
    };
  } finally {
    redis.disconnect();
  }
}

function objectStorageCredential(
  env: NodeJS.ProcessEnv,
  canonical: string,
  legacy: string,
): string {
  const next = env[canonical]?.trim();
  const old = env[legacy]?.trim();
  if (next && old && next !== old) {
    throw new Error(`${canonical} and ${legacy} differ`);
  }
  const value = next || old;
  if (!value) {
    throw new Error(`${canonical} is required`);
  }
  if (!next && old) {
    console.warn(
      `${legacy} is deprecated. Set ${canonical}. This alias will be removed after 2026-12-31.`,
    );
  }
  return value;
}

function s3Client(env: NodeJS.ProcessEnv): S3Client {
  return new S3Client({
    endpoint: required(env, 'S3_ENDPOINT'),
    region: env.S3_REGION ?? 'us-east-1',
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: {
      accessKeyId: objectStorageCredential(env, 'S3_ACCESS_KEY_ID', 'S3_ACCESS_KEY'),
      secretAccessKey: objectStorageCredential(env, 'S3_SECRET_ACCESS_KEY', 'S3_SECRET_KEY'),
    },
  });
}

async function minioFingerprint(
  env: NodeJS.ProcessEnv,
  bucket: string,
): Promise<{ hash: string; count: number }> {
  const client = s3Client(env);
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const item of page.Contents ?? []) {
      if (item.Key) {
        keys.push(item.Key);
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  keys.sort();
  return {
    count: keys.length,
    hash: createHash('sha256').update(keys.join('\n')).digest('hex'),
  };
}

async function captureDevelopmentSnapshot(env: NodeJS.ProcessEnv): Promise<DevelopmentSnapshot> {
  const adminUrl = required(env, 'POSTGRES_ADMIN_URL');
  const pg = await pgSnapshot(adminUrl, databaseNameOf(adminUrl));
  const redis = await redisKeyFingerprint(
    required(env, 'REDIS_URL'),
    env.REDIS_KEY_PREFIX || 'sgr',
  );
  const minio = await minioFingerprint(env, env.S3_BUCKET || 'sgr-attachments');
  return {
    ...pg,
    redisKeyHash: redis.hash,
    redisKeyCount: redis.count,
    minioKeyHash: minio.hash,
    minioKeyCount: minio.count,
  };
}

function freeE2ePorts(): void {
  for (const port of [E2E_WEB_PORT, E2E_API_PORT, E2E_WORKER_HEALTH_PORT]) {
    const listed = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
    const pids = (listed.stdout ?? '')
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
    for (const pid of pids) {
      spawnSync('kill', [pid], { stdio: 'ignore' });
    }
  }
}

function assertSnapshotsEqual(before: DevelopmentSnapshot, after: DevelopmentSnapshot): void {
  const fields: Array<keyof DevelopmentSnapshot> = [
    'usersCount',
    'actsCount',
    'objectsCount',
    'orgsCount',
    'defectTypesCount',
    'auditCount',
    'usersChecksum',
    'superEmail',
    'superStatus',
    'superUpdated',
    'redisKeyHash',
    'redisKeyCount',
    'minioKeyHash',
    'minioKeyCount',
  ];
  for (const field of fields) {
    if (before[field] !== after[field]) {
      throw new Error(`Development ${field} changed during Playwright`);
    }
  }
}

async function recreateE2eDatabase(adminUrl: string): Promise<void> {
  const admin = new Pool({
    connectionString: postgresUrlWithoutSchema(withDatabaseName(adminUrl, 'postgres')),
    max: 1,
  });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${E2E_DATABASE_NAME} WITH (FORCE)`);
    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 300);
    });
    await admin.query(`CREATE DATABASE ${E2E_DATABASE_NAME}`);
    await admin.query(
      `GRANT CONNECT, CREATE, TEMP ON DATABASE ${E2E_DATABASE_NAME} TO sgr_app, sgr_auth, sgr_worker, sgr_owner`,
    );
  } finally {
    await admin.end();
  }
  const db = new Pool({
    connectionString: postgresUrlWithoutSchema(withDatabaseName(adminUrl, E2E_DATABASE_NAME)),
    max: 1,
  });
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await db.query('ALTER SCHEMA public OWNER TO sgr_owner');
  } finally {
    await db.end();
  }
}

async function dropE2eDatabase(adminUrl: string): Promise<void> {
  const admin = new Pool({
    connectionString: postgresUrlWithoutSchema(withDatabaseName(adminUrl, 'postgres')),
    max: 1,
  });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${E2E_DATABASE_NAME} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function ensureE2eBucket(env: NodeJS.ProcessEnv): Promise<void> {
  const client = s3Client(env);
  try {
    await client.send(new HeadBucketCommand({ Bucket: E2E_S3_BUCKET }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: E2E_S3_BUCKET }));
  }
}

async function emptyE2eBucket(env: NodeJS.ProcessEnv): Promise<void> {
  const client = s3Client(env);
  const listed = await minioFingerprint(env, E2E_S3_BUCKET);
  if (listed.count === 0) {
    return;
  }
  const { DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  const page = await client.send(new ListObjectsV2Command({ Bucket: E2E_S3_BUCKET }));
  const objects = (page.Contents ?? [])
    .map((item) => item.Key)
    .filter((key): key is string => Boolean(key))
    .map((Key) => ({ Key }));
  if (objects.length > 0) {
    await client.send(
      new DeleteObjectsCommand({ Bucket: E2E_S3_BUCKET, Delete: { Objects: objects } }),
    );
  }
}

async function ensureRedisE2eNamespace(
  redisUrl: string,
  originalEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const probe = async (): Promise<boolean> => {
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    try {
      await redis.connect();
      await redis.set(`${E2E_REDIS_KEY_PREFIX}:probe`, '1', 'EX', 5);
      await redis.del(`${E2E_REDIS_KEY_PREFIX}:probe`);
      return true;
    } catch {
      return false;
    } finally {
      redis.disconnect();
    }
  };
  if (await probe()) {
    return;
  }
  run(
    'docker',
    [
      'compose',
      '-f',
      'infra/docker/compose.yaml',
      '--env-file',
      '.env',
      'up',
      '-d',
      '--force-recreate',
      'redis',
    ],
    originalEnv,
    'recreate Redis ACL for E2E prefix',
  );
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await probe()) {
      return;
    }
    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 500);
    });
  }
  throw new Error('Redis E2E namespace sgr-e2e is not allowed by ACL');
}

async function deleteE2eRedisKeys(redisUrl: string): Promise<void> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(
        cursor,
        'MATCH',
        `${E2E_REDIS_KEY_PREFIX}:*`,
        'COUNT',
        200,
      );
      cursor = next;
      if (batch.length > 0) {
        await redis.del(...batch);
      }
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
}

async function assertE2eSuperAdmin(migrationUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: postgresUrlWithoutSchema(migrationUrl), max: 1 });
  try {
    await pool.query('SET ROLE sgr_owner');
    const rows = await pool.query<{ email: string }>(
      'SELECT email FROM public.sgr_active_super_admins()',
    );
    if (!rows.rows.some((row) => row.email === TEST_SUPER_ADMIN_EMAIL)) {
      throw new Error('Playwright SUPER_ADMIN fixture was not created in the E2E database');
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const original: NodeJS.ProcessEnv = { ...process.env };
  const developmentName = databaseNameOf(required(original, 'POSTGRES_ADMIN_URL'));
  if (developmentName !== 'sgr_registry') {
    throw new Error(
      `Refusing to run Playwright against unexpected development database "${developmentName}"`,
    );
  }
  freeE2ePorts();
  await new Promise((resolveDelay) => {
    setTimeout(resolveDelay, 500);
  });
  const before = await captureDevelopmentSnapshot(original);
  const e2eDatabaseUrl =
    original.E2E_DATABASE_URL ??
    withDatabaseName(required(original, 'POSTGRES_ADMIN_URL'), E2E_DATABASE_NAME);
  applyE2eEnv(e2eDatabaseUrl, process.env);
  assertE2eDatabaseTarget(process.env);
  await ensureRedisE2eNamespace(required(process.env, 'REDIS_URL'), original);

  await recreateE2eDatabase(required(original, 'POSTGRES_ADMIN_URL'));
  run('pnpm', ['db:roles:provision'], original, 'db:roles:provision');
  run('pnpm', ['db:migrate'], process.env, 'E2E migrate');
  run('pnpm', ['db:roles:provision'], original, 'db:roles:provision after migrate');
  run('pnpm', ['db:seed'], process.env, 'E2E seed');
  run(
    'pnpm',
    ['--filter', '@sgr-registry/database', 'exec', 'tsx', 'scripts/ensure-test-super-admin.ts'],
    process.env,
    'E2E SUPER_ADMIN fixture',
  );
  await ensureE2eBucket(process.env);

  const playwright = spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', ...process.argv.slice(2).filter((arg) => arg !== '--')],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      stdio: 'inherit',
    },
  );

  let isolationError: unknown;
  try {
    await assertE2eSuperAdmin(required(process.env, 'MIGRATION_DATABASE_URL'));
    const after = await captureDevelopmentSnapshot(original);
    assertSnapshotsEqual(before, after);
  } catch (error) {
    isolationError = error;
  } finally {
    await dropE2eDatabase(required(original, 'POSTGRES_ADMIN_URL'));
    await deleteE2eRedisKeys(required(process.env, 'REDIS_URL'));
    await emptyE2eBucket(process.env);
  }

  if (playwright.status !== 0) {
    if (isolationError) {
      const isolationMessage =
        isolationError instanceof Error ? isolationError.message : 'development isolation failed';
      console.error(isolationMessage);
    }
    process.exit(playwright.status ?? 1);
  }
  if (isolationError) {
    throw isolationError;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Playwright E2E runner failed';
  console.error(message);
  process.exit(1);
});
