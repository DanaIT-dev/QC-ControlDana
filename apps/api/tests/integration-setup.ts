import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll } from 'vitest';
import { applyTestDatabaseEnv, assertSafeTestDatabaseUrl } from '@sgr-registry/database';
import { assertNoPgQueryDeprecationWarning } from '../../../packages/database/tests/pg-warning-guard';

const repoRoot = resolve(import.meta.dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile });

process.env.NODE_ENV = 'test';
process.env.REDIS_KEY_PREFIX = 'sgr-test';
process.env.AUTH_LOGIN_WINDOW_SECONDS ??= '60';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for API integration tests');
}
assertSafeTestDatabaseUrl(testDatabaseUrl);
applyTestDatabaseEnv(testDatabaseUrl);
assertSafeTestDatabaseUrl(process.env.DATABASE_URL ?? '');
assertSafeTestDatabaseUrl(process.env.AUTH_DATABASE_URL ?? '');
assertSafeTestDatabaseUrl(process.env.WORKER_DATABASE_URL ?? '');
assertSafeTestDatabaseUrl(process.env.MIGRATION_DATABASE_URL ?? '');

afterAll(() => {
  assertNoPgQueryDeprecationWarning();
});
