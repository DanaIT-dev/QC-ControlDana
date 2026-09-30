import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '../../..');
const runFile = resolve(repoRoot, 'tmp/database-integration-run-id');

export function setup(): void {
  mkdirSync(resolve(repoRoot, 'tmp'), { recursive: true });
  writeFileSync(runFile, `run-${randomUUID()}\n`);
}

export function teardown(): void {
  const result = spawnSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/cleanup-test-bucket.ts', 'run', runFile],
    { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Database integration MinIO cleanup failed');
  }
}
