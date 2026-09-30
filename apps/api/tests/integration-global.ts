import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '../../..');
const runFile = resolve(repoRoot, 'tmp/api-integration-run-id');

export function setup(): void {
  mkdirSync(resolve(repoRoot, 'tmp'), { recursive: true });
  writeFileSync(runFile, `run-${randomUUID()}\n`);
}

export function teardown(): void {
  const runId = readFileSync(runFile, 'utf8').trim();
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      '@sgr-registry/database',
      'exec',
      'tsx',
      'scripts/cleanup-test-bucket.ts',
      'run',
      runFile,
    ],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, SGR_TEST_RUN_ID: runId } },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'API integration MinIO cleanup failed');
  }
}
