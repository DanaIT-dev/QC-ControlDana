import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';
import { Pool } from 'pg';
import { applyTestDatabaseEnv } from '../src/test-env';
import { assertSafeTestDatabaseUrl } from '../src/test-database';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile, override: true });

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

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('SELECT 1');
  } catch {
    console.error('Integration tests were not started: cannot connect to the test database.');
    console.error(
      'Start local infrastructure: docker compose -f infra/docker/compose.yaml --env-file .env up -d',
    );
    console.error(
      'Then run: pnpm db:migrate  (against TEST_DATABASE_URL) and retry pnpm test:integration.',
    );
    process.exit(1);
  } finally {
    await pool.end();
  }

  process.env.NODE_ENV = 'test';
  applyTestDatabaseEnv(databaseUrl);

  const extraArgs = process.argv.slice(2).filter((arg) => arg !== '--');
  const child = spawn(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.mts', ...extraArgs],
    {
      cwd: resolve(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    },
  );

  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });
}

void main();
