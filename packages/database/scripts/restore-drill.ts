import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { config as loadDotenv } from 'dotenv';
import {
  assertRestoreDatabaseName,
  dumpDatabase,
  execSql,
  readEncryptedBackup,
  restoreDatabase,
  writeEncryptedBackup,
} from '../src/backup-runtime';

const SRC_DB = 'sgr_restore_drill_src';
const DST_DB = 'sgr_restore_drill_dst';
const SRC_BUCKET = 'sgr-restore-drill-src-test';
const DST_BUCKET = 'sgr-restore-drill-dst-test';
const DEVELOPMENT_DB = 'sgr_registry';
const DEVELOPMENT_BUCKET = 'sgr-attachments';
const OBJECT_KEY = 'restore-drill/sample.txt';
const OBJECT_BODY = Buffer.from('restore-drill-payload');

const repoRoot = resolve(__dirname, '../../..');
loadDotenv({ path: resolve(repoRoot, '.env'), override: false });

function exitWith(code: number, event: string, detail: string): never {
  process.stderr.write(`${JSON.stringify({ service: 'backup', level: 'error', event, detail })}\n`);
  process.exit(code);
}

function s3(): S3Client {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    exitWith(2, 'backup_config', 'S3 configuration is incomplete');
  }
  return new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function listCount(client: S3Client, bucket: string): Promise<number | null> {
  try {
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    return listed.KeyCount ?? listed.Contents?.length ?? 0;
  } catch {
    return null;
  }
}

function developmentCounts(): string | null {
  try {
    const exists = execSql('postgres', "SELECT 1 FROM pg_database WHERE datname = 'sgr_registry'");
    if (!exists.includes('1')) {
      return null;
    }
    return execSql(
      DEVELOPMENT_DB,
      `SELECT json_build_object(
        'users', (SELECT count(*) FROM users),
        'acts', (SELECT count(*) FROM acts),
        'defects', (SELECT count(*) FROM defect_items),
        'assignments', (SELECT count(*) FROM defect_item_engineers),
        'unresolved', (SELECT count(*) FROM imported_engineer_references),
        'organizations', (SELECT count(*) FROM organizations),
        'audit', (SELECT count(*) FROM audit_logs),
        'batches', (SELECT count(*) FROM import_batches)
      )::text`,
    ).trim();
  } catch {
    return null;
  }
}

function dropDrillDatabases(): void {
  for (const name of [SRC_DB, DST_DB]) {
    assertRestoreDatabaseName(name);
    execSql(
      'postgres',
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid();`,
    );
    execSql('postgres', `DROP DATABASE IF EXISTS ${name}`);
  }
}

function resetDrillDatabases(): void {
  dropDrillDatabases();
  for (const name of [SRC_DB, DST_DB]) {
    execSql('postgres', `CREATE DATABASE ${name}`);
  }
}

class DrillFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function resetDrillBuckets(client: S3Client): Promise<void> {
  for (const bucket of [SRC_BUCKET, DST_BUCKET]) {
    if (!bucket.endsWith('-test') || !bucket.includes('restore-drill')) {
      throw new Error(`Refusing to reset bucket ${bucket}`);
    }
    try {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
      for (const object of listed.Contents ?? []) {
        if (object.Key) {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
        }
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    } catch {
      // The bucket may not exist yet.
    }
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    exitWith(2, 'backup_refused', 'Restore drill is forbidden when NODE_ENV=production');
  }
  const client = s3();
  const before = developmentCounts();
  const developmentObjectsBefore = await listCount(client, DEVELOPMENT_BUCKET);
  const scratch = join(tmpdir(), `sgr-restore-drill-${Date.now()}`);
  const backupRoot = join(scratch, 'backups');
  const keyFile = join(scratch, 'keys', 'backup.key');
  mkdirSync(join(scratch, 'keys'), { recursive: true });
  mkdirSync(backupRoot, { recursive: true });
  writeFileSync(keyFile, 'restore-drill-key-material-not-for-production-use');

  try {
    await resetDrillBuckets(client);
    resetDrillDatabases();
    execSql(
      SRC_DB,
      `CREATE TABLE drill_parents (id text PRIMARY KEY, name text NOT NULL);
       CREATE TABLE drill_children (
         id text PRIMARY KEY,
         parent_id text NOT NULL REFERENCES drill_parents(id),
         note text NOT NULL
       );
       INSERT INTO drill_parents (id, name) VALUES ('p1', 'parent');
       INSERT INTO drill_children (id, parent_id, note) VALUES ('c1', 'p1', 'child');`,
    );
    await client.send(new CreateBucketCommand({ Bucket: SRC_BUCKET }));
    await client.send(
      new PutObjectCommand({ Bucket: SRC_BUCKET, Key: OBJECT_KEY, Body: OBJECT_BODY }),
    );
    const dump = dumpDatabase(SRC_DB);
    const backup = await writeEncryptedBackup({
      repoRoot,
      backupRoot,
      keyFile,
      databaseName: SRC_DB,
      bucket: SRC_BUCKET,
      dump,
      objects: [
        {
          key: OBJECT_KEY,
          body: OBJECT_BODY,
          sha256: createHash('sha256').update(OBJECT_BODY).digest('hex'),
        },
      ],
      metadata: { purpose: 'restore-drill', environment: 'isolated-test' },
    });
    const restored = await readEncryptedBackup({ directory: backup.directory, keyFile });
    if (restored.manifest.ciphertextSha256 !== backup.manifest.ciphertextSha256) {
      throw new DrillFailure(4, 'ciphertext checksum changed after backup');
    }
    assertRestoreDatabaseName(DST_DB);
    restoreDatabase(DST_DB, restored.dump);
    const relation = execSql(
      DST_DB,
      `SELECT drill_children.note || ':' || drill_parents.name
       FROM drill_children JOIN drill_parents ON drill_parents.id = drill_children.parent_id`,
    ).trim();
    if (relation !== 'child:parent') {
      throw new DrillFailure(5, 'restored database relation does not match');
    }
    await client.send(new CreateBucketCommand({ Bucket: DST_BUCKET }));
    for (const object of restored.objects) {
      await client.send(
        new PutObjectCommand({ Bucket: DST_BUCKET, Key: object.key, Body: object.body }),
      );
    }
    const downloaded = await client.send(
      new GetObjectCommand({ Bucket: DST_BUCKET, Key: OBJECT_KEY }),
    );
    const bytes = Buffer.from(await downloaded.Body!.transformToByteArray());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== restored.objects[0]?.sha256 || bytes.length !== OBJECT_BODY.length) {
      throw new DrillFailure(5, 'restored object checksum does not match');
    }
    const after = developmentCounts();
    const developmentObjectsAfter = await listCount(client, DEVELOPMENT_BUCKET);
    if (before !== after || developmentObjectsBefore !== developmentObjectsAfter) {
      throw new DrillFailure(6, 'development database or bucket changed during the drill');
    }
    process.stdout.write(
      `${JSON.stringify({
        service: 'backup',
        level: 'info',
        event: 'restore_drill_passed',
        restoredRows: relation,
        restoredBytes: bytes.length,
        restoredSha256: digest,
        developmentUnchanged: true,
      })}\n`,
    );
  } catch (error) {
    const code = error instanceof DrillFailure ? error.code : 3;
    const message = error instanceof Error ? error.message : 'restore drill failed';
    process.stderr.write(
      `${JSON.stringify({ service: 'backup', level: 'error', event: 'restore_drill_failed', detail: message.slice(0, 400) })}\n`,
    );
    process.exitCode = code;
  } finally {
    try {
      dropDrillDatabases();
    } catch {
      process.stderr.write(
        '{"service":"backup","level":"error","event":"drill_database_cleanup_failed"}\n',
      );
      process.exitCode = process.exitCode ?? 3;
    }
    try {
      await resetDrillBuckets(client);
    } catch {
      process.stderr.write(
        '{"service":"backup","level":"error","event":"drill_bucket_cleanup_failed"}\n',
      );
      process.exitCode = process.exitCode ?? 3;
    }
    const afterCleanup = developmentCounts();
    const objectsAfterCleanup = await listCount(client, DEVELOPMENT_BUCKET);
    if (before !== afterCleanup || developmentObjectsBefore !== objectsAfterCleanup) {
      process.stderr.write(
        '{"service":"backup","level":"error","event":"development_changed","detail":"development data changed during drill cleanup"}\n',
      );
      process.exitCode = 6;
    }
  }
}

void main();
