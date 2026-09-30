import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { config as loadDotenv } from 'dotenv';
import { execSql } from '../src/backup-runtime';

const repoRoot = resolve(__dirname, '../../..');
loadDotenv({ path: resolve(repoRoot, '.env'), override: false });

const bucket = 'sgr-attachments';

function exitWith(detail: string): never {
  process.stderr.write(`${JSON.stringify({ service: 'inventory', level: 'error', detail })}\n`);
  process.exit(2);
}

function s3(): S3Client {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim() || process.env.S3_ACCESS_KEY?.trim();
  const secretAccessKey =
    process.env.S3_SECRET_ACCESS_KEY?.trim() || process.env.S3_SECRET_KEY?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    exitWith('S3 configuration is incomplete');
  }
  return new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function listObjects(): Promise<Array<{ key: string; size: number }>> {
  const client = s3();
  const objects: Array<{ key: string; size: number }> = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const item of page.Contents ?? []) {
      if (item.Key) {
        objects.push({ key: item.Key, size: item.Size ?? 0 });
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  objects.sort((left, right) => left.key.localeCompare(right.key));
  return objects;
}

function rows(sql: string): string[] {
  return execSql('sgr_registry', sql)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function main(): Promise<void> {
  const objects = await listObjects();
  const referenced = rows(
    `SELECT "objectKey" FROM attachments WHERE "objectKey" IS NOT NULL AND bucket = '${bucket}' ORDER BY "objectKey"`,
  );
  const objectKeys = new Set(objects.map((object) => object.key));
  const referencedKeys = new Set(referenced);
  const orphans = objects.filter((object) => !referencedKeys.has(object.key));
  const missing = referenced.filter((key) => !objectKeys.has(key));
  const prefixCounts: Record<string, number> = {};
  for (const orphan of orphans) {
    const prefix = orphan.key.split('/')[0] || '(root)';
    prefixCounts[prefix] = (prefixCounts[prefix] ?? 0) + 1;
  }
  const manifest = objects.map((object) => `${object.key}\t${object.size}`).join('\n');
  const report = {
    bucket,
    objectCount: objects.length,
    totalBytes: objects.reduce((sum, object) => sum + object.size, 0),
    manifestSha256: createHash('sha256').update(manifest).digest('hex'),
    referencedObjects: referenced.length,
    orphanObjects: orphans.length,
    missingObjects: missing.length,
    orphanPrefixes: prefixCounts,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'inventory failed';
  exitWith(message.replace(/accessKeyId=\S+/gi, 'accessKeyId=[redacted]'));
});
