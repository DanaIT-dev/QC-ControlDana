import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { deleteCurrentTestRun, emptyKnownTestBucket } from '../src/test-bucket-cleanup';

const repoRoot = resolve(__dirname, '../../..');
loadDotenv({ path: resolve(repoRoot, '.env') });

const endpoint = process.env.S3_ENDPOINT ?? '';
const bucket = process.env.S3_TEST_BUCKET ?? 'sgr-attachments-test';
const mode = process.argv[2] ?? 'run';

async function main(): Promise<void> {
  if (mode === 'count') {
    const { ListObjectsV2Command, S3Client } = await import('@aws-sdk/client-s3');
    const { assertSafeTestBucket, assertSafeTestEndpoint } = await import('../src/test-bucket');
    const safeBucket = assertSafeTestBucket(bucket);
    assertSafeTestEndpoint(endpoint);
    const s3 = new S3Client({
      endpoint,
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? '',
        secretAccessKey: process.env.S3_SECRET_KEY ?? '',
      },
    });
    let token: string | undefined;
    let count = 0;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: safeBucket, ContinuationToken: token }),
      );
      count += page.KeyCount ?? 0;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    console.log(count);
    return;
  }
  if (mode === 'empty-test-bucket') {
    const removed = await emptyKnownTestBucket({ bucket, endpoint });
    console.log(`removed ${removed} objects from the test bucket`);
    return;
  }
  const runFile = process.argv[3];
  if (!runFile || !existsSync(runFile)) {
    console.log('test run cleanup skipped');
    return;
  }
  const runId = readFileSync(runFile, 'utf8').trim();
  const removed = await deleteCurrentTestRun({ bucket, endpoint, runId });
  console.log(`removed ${removed} objects for the current test run`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'test bucket cleanup failed';
  console.error(message);
  process.exit(1);
});
