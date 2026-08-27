import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';
import { assertSafeTestDatabaseUrl } from '../../../packages/database/src/test-database';
import { assertSafeTestBucket } from '../../../packages/database/src/test-bucket';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile });

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    'Integration tests were not started: set TEST_DATABASE_URL to a dedicated database whose name ends with _test.',
  );
  process.exit(1);
}

try {
  assertSafeTestDatabaseUrl(databaseUrl);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unsafe test database URL';
  console.error(message);
  process.exit(1);
}

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.REDIS_KEY_PREFIX = 'sgr-test';
process.env.AUTH_LOGIN_MAX_FAILURES = process.env.AUTH_LOGIN_MAX_FAILURES ?? '5';
process.env.AUTH_LOGIN_WINDOW_SECONDS = process.env.AUTH_LOGIN_WINDOW_SECONDS ?? '30';

try {
  assertSafeTestBucket(process.env.S3_TEST_BUCKET ?? 'sgr-attachments-test');
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unsafe test bucket';
  console.error(message);
  process.exit(1);
}

const child = spawn(
  'pnpm',
  ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.mts'],
  {
    cwd: resolve(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  },
);

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
