import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ActsImportBackupResult {
  filePath: string;
  sha256: string;
  sizeBytes: number;
  verified: boolean;
}

function run(
  command: string,
  args: string[],
  input?: Buffer,
): { status: number; stdout: Buffer; stderr: string } {
  const result = spawnSync(command, args, {
    input,
    encoding: input ? undefined : 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ''),
    stderr: result.stderr ? String(result.stderr) : '',
  };
}

export function createDevelopmentActsImportBackup(input: {
  databaseName: string;
  backupDir: string;
}): ActsImportBackupResult {
  if (input.databaseName !== 'sgr_registry') {
    throw new Error('Backup is only created for development database sgr_registry');
  }
  mkdirSync(input.backupDir, { recursive: true, mode: 0o700 });
  chmodSync(input.backupDir, 0o700);
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const filePath = resolve(input.backupDir, `sgr_registry-legacy-acts-${stamp}.dump`);
  const dump = run('docker', [
    'exec',
    'sgr-registry-postgres',
    'pg_dump',
    '-Fc',
    '-U',
    'sgr_registry',
    '-d',
    'sgr_registry',
  ]);
  if (dump.status !== 0 || dump.stdout.length === 0) {
    throw new Error(`pg_dump failed: ${dump.stderr || 'empty archive'}`);
  }
  writeFileSync(filePath, dump.stdout, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  const list = run(
    'docker',
    ['exec', '-i', 'sgr-registry-postgres', 'pg_restore', '--list'],
    dump.stdout,
  );
  if (list.status !== 0) {
    throw new Error(`pg_restore --list failed: ${list.stderr}`);
  }
  const sha256 = createHash('sha256').update(dump.stdout).digest('hex');
  return {
    filePath,
    sha256,
    sizeBytes: dump.stdout.length,
    verified: true,
  };
}
