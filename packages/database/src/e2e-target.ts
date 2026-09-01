import {
  databaseNameOf,
  isLoopbackHost,
  postgresHostOf,
  postgresUserOf,
  redisLogicalDbOf,
  remapDatabaseUrl,
  remapRedisLogicalDb,
} from './database-url';

export const E2E_DATABASE_NAME = 'sgr_registry_e2e';
export const E2E_TARGET_CONFIRM_VALUE = 'sgr_registry_e2e';
export const E2E_REDIS_LOGICAL_DB = 14;
export const E2E_REDIS_KEY_PREFIX = 'sgr-e2e';
export const E2E_S3_BUCKET = 'sgr-attachments-e2e';
export const E2E_WEB_PORT = 3200;
export const E2E_API_PORT = 3201;
export const E2E_WORKER_HEALTH_PORT = 3202;
export const DEVELOPMENT_DATABASE_NAME = 'sgr_registry';
export const DEVELOPMENT_REDIS_KEY_PREFIX = 'sgr';
export const DEVELOPMENT_S3_BUCKET = 'sgr-attachments';
export const DEVELOPMENT_REDIS_LOGICAL_DB = 0;

const BOOTSTRAP_DB_USERS = new Set(['sgr_registry', 'postgres']);
const OWNER_OR_MIGRATOR = new Set(['sgr_owner', 'sgr_migrator']);

export class E2eTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eTargetError';
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new E2eTargetError(`E2E target rejected: ${name} is missing`);
  }
  return value;
}

function reject(setting: string, reason: string): never {
  throw new E2eTargetError(`E2E target rejected: ${setting} ${reason}`);
}

function parsePostgresUrl(setting: string, url: string): URL {
  try {
    return new URL(url);
  } catch {
    reject(setting, 'is not a valid PostgreSQL URL');
  }
}

export function assertE2eDatabaseName(databaseName: string, setting = 'database'): void {
  if (!databaseName) {
    reject(setting, 'name is empty');
  }
  if (databaseName === DEVELOPMENT_DATABASE_NAME) {
    reject(setting, `name "${DEVELOPMENT_DATABASE_NAME}" is the development database`);
  }
  if (databaseName.endsWith('_test')) {
    reject(setting, `name "${databaseName}" is the integration test database`);
  }
  if (databaseName !== E2E_DATABASE_NAME) {
    reject(setting, `name "${databaseName}" is not the E2E database`);
  }
}

export function assertE2eDatabaseTarget(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production') {
    reject('NODE_ENV', 'value "production" is not an E2E target');
  }
  if (env.SGR_E2E_TARGET_CONFIRM !== E2E_TARGET_CONFIRM_VALUE) {
    reject('SGR_E2E_TARGET_CONFIRM', 'must equal the E2E database name');
  }

  const databaseUrl = required(env, 'DATABASE_URL');
  const authUrl = required(env, 'AUTH_DATABASE_URL');
  const workerUrl = required(env, 'WORKER_DATABASE_URL');
  const migrationUrl = required(env, 'MIGRATION_DATABASE_URL');
  const redisUrl = required(env, 'REDIS_URL');
  const redisPrefix = required(env, 'REDIS_KEY_PREFIX');
  const bucket = required(env, 'S3_BUCKET');

  const urls: Array<[string, string]> = [
    ['DATABASE_URL', databaseUrl],
    ['AUTH_DATABASE_URL', authUrl],
    ['WORKER_DATABASE_URL', workerUrl],
    ['MIGRATION_DATABASE_URL', migrationUrl],
  ];
  const names = new Set<string>();
  for (const [setting, url] of urls) {
    parsePostgresUrl(setting, url);
    const name = databaseNameOf(url);
    names.add(name);
    assertE2eDatabaseName(name, setting);
    const host = postgresHostOf(url);
    if (!isLoopbackHost(host)) {
      reject(setting, `host "${host || '(empty)'}" is not a local E2E target`);
    }
  }
  if (names.size !== 1) {
    reject('database URLs', 'point at different database names');
  }

  const runtimeUser = postgresUserOf(databaseUrl);
  if (BOOTSTRAP_DB_USERS.has(runtimeUser) || OWNER_OR_MIGRATOR.has(runtimeUser)) {
    reject('DATABASE_URL', `role "${runtimeUser || '(empty)'}" is not allowed at runtime`);
  }
  if (runtimeUser !== 'sgr_app_user') {
    reject('DATABASE_URL', `role "${runtimeUser || '(empty)'}" is not the API runtime role`);
  }

  const authUser = postgresUserOf(authUrl);
  if (BOOTSTRAP_DB_USERS.has(authUser) || OWNER_OR_MIGRATOR.has(authUser)) {
    reject('AUTH_DATABASE_URL', `role "${authUser || '(empty)'}" is not allowed at runtime`);
  }
  if (authUser !== 'sgr_auth_user') {
    reject('AUTH_DATABASE_URL', `role "${authUser || '(empty)'}" is not the auth runtime role`);
  }

  const workerUser = postgresUserOf(workerUrl);
  if (BOOTSTRAP_DB_USERS.has(workerUser) || OWNER_OR_MIGRATOR.has(workerUser)) {
    reject('WORKER_DATABASE_URL', `role "${workerUser || '(empty)'}" is not allowed at runtime`);
  }
  if (workerUser !== 'sgr_worker_user') {
    reject(
      'WORKER_DATABASE_URL',
      `role "${workerUser || '(empty)'}" is not the worker runtime role`,
    );
  }

  const migratorUser = postgresUserOf(migrationUrl);
  if (BOOTSTRAP_DB_USERS.has(migratorUser) || migratorUser === 'sgr_owner') {
    reject(
      'MIGRATION_DATABASE_URL',
      `role "${migratorUser || '(empty)'}" is not the migrator role`,
    );
  }
  if (migratorUser !== 'sgr_migrator') {
    reject(
      'MIGRATION_DATABASE_URL',
      `role "${migratorUser || '(empty)'}" is not the migrator role`,
    );
  }

  let redisHost = '';
  try {
    redisHost = new URL(redisUrl).hostname;
  } catch {
    reject('REDIS_URL', 'is not a valid Redis URL');
  }
  if (!isLoopbackHost(redisHost)) {
    reject('REDIS_URL', `host "${redisHost || '(empty)'}" is not a local E2E target`);
  }
  const redisDb = redisLogicalDbOf(redisUrl);
  if (redisDb === DEVELOPMENT_REDIS_LOGICAL_DB) {
    reject('REDIS_URL', `logical database "${redisDb}" is the development namespace`);
  }
  if (redisDb !== E2E_REDIS_LOGICAL_DB) {
    reject('REDIS_URL', `logical database "${redisDb}" is not the E2E namespace`);
  }
  if (env.WORKER_REDIS_URL) {
    const workerRedisDb = redisLogicalDbOf(env.WORKER_REDIS_URL);
    if (workerRedisDb !== E2E_REDIS_LOGICAL_DB) {
      reject('WORKER_REDIS_URL', `logical database "${workerRedisDb}" is not the E2E namespace`);
    }
  }
  if (redisPrefix === DEVELOPMENT_REDIS_KEY_PREFIX || redisPrefix === 'sgr-test') {
    reject('REDIS_KEY_PREFIX', `value "${redisPrefix}" matches a non-E2E namespace`);
  }
  if (redisPrefix !== E2E_REDIS_KEY_PREFIX) {
    reject('REDIS_KEY_PREFIX', `value "${redisPrefix}" is not the E2E namespace`);
  }

  if (bucket === DEVELOPMENT_S3_BUCKET || bucket === 'sgr-attachments-test') {
    reject('S3_BUCKET', `value "${bucket}" matches a non-E2E bucket`);
  }
  if (bucket !== E2E_S3_BUCKET) {
    reject('S3_BUCKET', `value "${bucket}" is not the E2E bucket`);
  }
}

export function applyE2eEnv(e2eDatabaseUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  const targetName = databaseNameOf(e2eDatabaseUrl);
  assertE2eDatabaseName(targetName, 'E2E_DATABASE_URL');
  const requiredUrl = (name: string): string => {
    const value = env[name];
    if (!value) {
      throw new E2eTargetError(`E2E target rejected: ${name} is missing`);
    }
    return value;
  };

  env.DATABASE_URL = remapDatabaseUrl(requiredUrl('DATABASE_URL'), e2eDatabaseUrl);
  env.AUTH_DATABASE_URL = remapDatabaseUrl(requiredUrl('AUTH_DATABASE_URL'), e2eDatabaseUrl);
  env.WORKER_DATABASE_URL = remapDatabaseUrl(requiredUrl('WORKER_DATABASE_URL'), e2eDatabaseUrl);
  env.MIGRATION_DATABASE_URL = remapDatabaseUrl(
    requiredUrl('MIGRATION_DATABASE_URL'),
    e2eDatabaseUrl,
  );
  env.REDIS_URL = remapRedisLogicalDb(requiredUrl('REDIS_URL'), E2E_REDIS_LOGICAL_DB);
  if (env.WORKER_REDIS_URL) {
    env.WORKER_REDIS_URL = remapRedisLogicalDb(env.WORKER_REDIS_URL, E2E_REDIS_LOGICAL_DB);
  }
  env.REDIS_KEY_PREFIX = E2E_REDIS_KEY_PREFIX;
  env.S3_BUCKET = env.E2E_S3_BUCKET || E2E_S3_BUCKET;
  env.S3_TEST_BUCKET = env.E2E_S3_BUCKET || E2E_S3_BUCKET;
  env.API_HOST = '127.0.0.1';
  env.WEB_PORT = String(E2E_WEB_PORT);
  env.API_PORT = String(E2E_API_PORT);
  env.WORKER_HEALTH_PORT = String(E2E_WORKER_HEALTH_PORT);
  env.WEB_ORIGIN = `http://127.0.0.1:${E2E_WEB_PORT}`;
  env.NEXT_PUBLIC_API_URL = `http://127.0.0.1:${E2E_API_PORT}`;
  env.PUBLIC_APP_URL = env.WEB_ORIGIN;
  env.SGR_E2E_TARGET_CONFIRM = E2E_TARGET_CONFIRM_VALUE;
  env.SGR_REQUIRE_E2E_TARGET = '1';
  env.SGR_KEEP_PROCESS_ENV = '1';
  env.SMTP_HOST = env.SMTP_HOST || '127.0.0.1';
  env.SMTP_PORT = env.SMTP_PORT || '1025';
  env.EMAIL_ENABLED = env.EMAIL_ENABLED || 'true';
}
