import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { backupClassFor, selectBackupsToDelete, type BackupRecord } from './backup-plan';
import { decryptFile, encryptFile, sha256File } from './backup-archive';

const POSTGRES_CONTAINER = process.env.SGR_POSTGRES_CONTAINER ?? 'sgr-registry-postgres';
const RESTORE_FORBIDDEN = new Set([
  'sgr_registry',
  'sgr_registry_test',
  'sgr_registry_e2e',
  'postgres',
  'template0',
  'template1',
]);
const BUNDLE_MAGIC = Buffer.from('SGRBUNDLE1\n');

export type BackupObject = {
  key: string;
  body: Buffer;
  sha256: string;
};

export type BackupManifest = {
  version: 1;
  createdAt: string;
  backupClass: 'daily' | 'weekly' | 'monthly';
  encryption: 'node-aes-256-gcm';
  databaseName: string;
  bucket: string;
  plaintextSha256: string;
  ciphertextSha256: string;
  components: Array<'postgresql' | 'object-storage' | 'config-metadata'>;
};

function log(
  level: 'info' | 'error',
  event: string,
  fields: Record<string, string | number | boolean>,
) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    service: 'backup',
    level,
    event,
    ...fields,
  });
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

function assertOutside(path: string, parent: string, message: string): void {
  const target = resolve(path);
  const root = resolve(parent);
  if (target === root || target.startsWith(`${root}${sep}`)) {
    throw new Error(message);
  }
}

export function assertRestoreDatabaseName(databaseName: string): void {
  if (RESTORE_FORBIDDEN.has(databaseName) || !/^sgr_restore_drill_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error(`Refusing to restore into database ${databaseName}`);
  }
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function dockerExec(args: string[], input?: Buffer): Buffer {
  const result = spawnSync('docker', ['exec', '-i', POSTGRES_CONTAINER, ...args], { input });
  if (result.error) {
    throw new Error('Docker is not available for the PostgreSQL backup');
  }
  if ((result.status ?? 1) !== 0) {
    const stderr = (result.stderr ?? Buffer.alloc(0)).toString('utf8');
    const safe = stderr.replace(/password=\S+/gi, 'password=[redacted]').slice(0, 400);
    throw new Error(`PostgreSQL command failed: ${safe || 'unknown error'}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

function assertDatabaseName(databaseName: string): void {
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new Error('Refusing a database name with unexpected characters');
  }
}

export function dumpDatabase(databaseName: string): Buffer {
  assertDatabaseName(databaseName);
  return dockerExec([
    'pg_dump',
    '-U',
    'sgr_registry',
    '-d',
    databaseName,
    '--format=custom',
    '--no-owner',
  ]);
}

export function restoreDatabase(databaseName: string, dump: Buffer): void {
  assertRestoreDatabaseName(databaseName);
  dockerExec(
    ['pg_restore', '-U', 'sgr_registry', '-d', databaseName, '--no-owner', '--no-acl'],
    dump,
  );
}

export function execSql(databaseName: string, sql: string): string {
  assertDatabaseName(databaseName);
  return dockerExec([
    'psql',
    '-U',
    'sgr_registry',
    '-d',
    databaseName,
    '-v',
    'ON_ERROR_STOP=1',
    '-At',
    '-c',
    sql,
  ]).toString('utf8');
}

function bundleBackup(input: {
  dump: Buffer;
  objects: BackupObject[];
  metadata: Record<string, string>;
}): Buffer {
  const header = Buffer.from(
    `${JSON.stringify({ metadata: input.metadata, objects: input.objects.map(({ key, sha256: digest }) => ({ key, sha256: digest })) })}\n`,
  );
  const chunks = [
    BUNDLE_MAGIC,
    Buffer.from(String(input.dump.length).padStart(12, '0')),
    input.dump,
    Buffer.from(String(header.length).padStart(12, '0')),
    header,
  ];
  for (const object of input.objects) {
    chunks.push(Buffer.from(String(object.body.length).padStart(12, '0')), object.body);
  }
  return Buffer.concat(chunks);
}

function unbundleBackup(plain: Buffer): {
  metadata: Record<string, string>;
  objects: BackupObject[];
  dump: Buffer;
} {
  if (!plain.subarray(0, BUNDLE_MAGIC.length).equals(BUNDLE_MAGIC)) {
    throw new Error('Decrypted backup has an unexpected header');
  }
  let offset = BUNDLE_MAGIC.length;
  const readLength = () => {
    const length = Number(plain.subarray(offset, offset + 12).toString('utf8'));
    offset += 12;
    return length;
  };
  const dumpLength = readLength();
  const dump = plain.subarray(offset, offset + dumpLength);
  offset += dumpLength;
  const headerLength = readLength();
  const header = JSON.parse(plain.subarray(offset, offset + headerLength).toString('utf8')) as {
    metadata: Record<string, string>;
    objects: Array<{ key: string; sha256: string }>;
  };
  offset += headerLength;
  const objects = header.objects.map((object) => {
    const size = readLength();
    const body = plain.subarray(offset, offset + size);
    offset += size;
    const digest = sha256(body);
    if (digest !== object.sha256) {
      throw new Error('Restored object checksum does not match the backup index');
    }
    return { key: object.key, body, sha256: digest };
  });
  return { metadata: header.metadata, objects, dump };
}

export async function writeEncryptedBackup(input: {
  repoRoot: string;
  backupRoot: string;
  keyFile: string;
  databaseName: string;
  bucket: string;
  dump: Buffer;
  objects: BackupObject[];
  metadata: Record<string, string>;
}): Promise<{ directory: string; manifest: BackupManifest }> {
  assertOutside(
    input.backupRoot,
    input.repoRoot,
    'Backup destination must be outside the repository',
  );
  assertOutside(
    input.keyFile,
    input.backupRoot,
    'Backup encryption key must not be stored inside the backup directory',
  );
  const createdAt = new Date();
  const id = createdAt.toISOString().replace(/[:.]/g, '-');
  const directory = join(input.backupRoot, id);
  const scratch = join(tmpdir(), `sgr-backup-scratch-${id}`);
  mkdirSync(directory, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  try {
    const plainBundle = join(scratch, 'bundle.bin');
    const plain = bundleBackup({
      dump: input.dump,
      objects: input.objects,
      metadata: input.metadata,
    });
    writeFileSync(plainBundle, plain);
    const plaintextSha256 = sha256(plain);
    const cipherPath = join(directory, 'backup.enc');
    encryptFile(plainBundle, cipherPath, input.keyFile);
    const ciphertextSha256 = await sha256File(cipherPath);
    const manifest: BackupManifest = {
      version: 1,
      createdAt: createdAt.toISOString(),
      backupClass: backupClassFor(createdAt),
      encryption: 'node-aes-256-gcm',
      databaseName: input.databaseName,
      bucket: input.bucket,
      plaintextSha256,
      ciphertextSha256,
      components: ['postgresql', 'object-storage', 'config-metadata'],
    };
    writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(directory, 'SHA256SUMS'),
      `${ciphertextSha256}  backup.enc\n${plaintextSha256}  bundle.plain\n`,
    );
    applyRetention(input.backupRoot);
    log('info', 'backup_completed', {
      backupClass: manifest.backupClass,
      ciphertextSha256,
      objectCount: input.objects.length,
      dumpBytes: input.dump.length,
    });
    return { directory, manifest };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function readEncryptedBackup(input: { directory: string; keyFile: string }): Promise<{
  manifest: BackupManifest;
  dump: Buffer;
  objects: BackupObject[];
}> {
  const manifest = JSON.parse(
    readFileSync(join(input.directory, 'manifest.json'), 'utf8'),
  ) as BackupManifest;
  const ciphertextSha256 = await sha256File(join(input.directory, 'backup.enc'));
  if (ciphertextSha256 !== manifest.ciphertextSha256) {
    throw new Error('Backup ciphertext checksum does not match the manifest');
  }
  const scratch = join(tmpdir(), `sgr-backup-read-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
  try {
    const plainBundle = join(scratch, 'bundle.bin');
    decryptFile(join(input.directory, 'backup.enc'), plainBundle, input.keyFile);
    const plain = readFileSync(plainBundle);
    if (sha256(plain) !== manifest.plaintextSha256) {
      throw new Error('Decrypted backup checksum does not match the manifest');
    }
    const decoded = unbundleBackup(plain);
    return { manifest, dump: decoded.dump, objects: decoded.objects };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function applyRetention(backupRoot: string): void {
  const records: BackupRecord[] = [];
  for (const entry of readdirSync(backupRoot)) {
    const manifestPath = join(backupRoot, entry, 'manifest.json');
    try {
      if (!statSync(manifestPath).isFile()) {
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
      records.push({ id: entry, createdAt: manifest.createdAt, backupClass: manifest.backupClass });
    } catch {
      continue;
    }
  }
  for (const id of selectBackupsToDelete(records)) {
    rmSync(join(backupRoot, id), { recursive: true, force: true });
    log('info', 'backup_expired', { id });
  }
}
