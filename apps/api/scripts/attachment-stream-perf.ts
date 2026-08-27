import { createHash, randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from '@sgr-registry/config';
import { assertSafeTestBucket, assertOwnedTestPrefix } from '@sgr-registry/database';
import { createAttachmentObjectKey } from '@sgr-registry/domain';
import { createS3Client, ObjectStore } from '../src/attachments/object-store';

const repoRoot = resolve(import.meta.dirname, '../../..');
loadDotenv({
  path: existsSync(resolve(repoRoot, '.env'))
    ? resolve(repoRoot, '.env')
    : resolve(repoRoot, '.env.example'),
});
process.env.NODE_ENV = 'test';

async function main(): Promise<void> {
  const config = loadConfig();
  const bucket = assertSafeTestBucket(config.S3_TEST_BUCKET);
  const store = new ObjectStore(createS3Client(config), bucket);
  await store.ensureBucket();
  const objectKey = createAttachmentObjectKey();
  assertOwnedTestPrefix(objectKey);

  const size = 12 * 1024 * 1024;
  const header = Buffer.from('%PDF-1.4\n');
  const rest = randomBytes(size - header.length);
  const expected = createHash('sha256').update(header).update(rest).digest('hex');
  const body = new PassThrough();
  const before = process.memoryUsage().rss;
  const upload = store.putStream(objectKey, body, 'application/pdf');
  body.write(header);
  const chunk = 64 * 1024;
  for (let offset = 0; offset < rest.length; offset += chunk) {
    const ok = body.write(rest.subarray(offset, offset + chunk));
    if (!ok) {
      await new Promise((resolve) => body.once('drain', resolve));
    }
  }
  body.end();
  await upload;
  const after = process.memoryUsage().rss;
  const stored = await store.head(objectKey);
  if (stored !== size) {
    throw new Error(`stored size ${stored} !== ${size}`);
  }
  const object = await store.getStream(objectKey);
  const hash = createHash('sha256');
  const stream = object.Body as NodeJS.ReadableStream;
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  const digest = hash.digest('hex');
  if (digest !== expected) {
    throw new Error('SHA-256 mismatch after streaming upload');
  }
  const growth = after - before;
  if (growth > size) {
    throw new Error(`RSS grew by ${growth} bytes, more than the ${size} byte payload`);
  }
  await store.deleteExact(objectKey);
  console.log(
    JSON.stringify({
      ok: true,
      bucket,
      objectKey,
      sizeBytes: size,
      sha256: digest,
      rssGrowthBytes: growth,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
