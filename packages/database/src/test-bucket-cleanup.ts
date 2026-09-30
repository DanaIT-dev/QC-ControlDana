import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { readObjectStorageCredential } from './object-storage';
import {
  assertOwnedTestPrefix,
  assertSafeTestBucket,
  assertSafeTestEndpoint,
  testRunObjectPrefix,
} from './test-bucket';

function client(endpoint: string): S3Client {
  assertSafeTestEndpoint(endpoint);
  const accessKeyId = readObjectStorageCredential(process.env, 'S3_ACCESS_KEY_ID', 'S3_ACCESS_KEY');
  const secretAccessKey = readObjectStorageCredential(
    process.env,
    'S3_SECRET_ACCESS_KEY',
    'S3_SECRET_KEY',
  );
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Test object storage credentials are not configured');
  }
  return new S3Client({
    endpoint,
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function removeKeys(bucket: string, endpoint: string, keys: string[]): Promise<number> {
  if (keys.length === 0) {
    return 0;
  }
  const s3 = client(endpoint);
  for (let index = 0; index < keys.length; index += 1000) {
    const chunk = keys.slice(index, index + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })) },
      }),
    );
  }
  return keys.length;
}

function isMissingBucket(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'NoSuchBucket'
  );
}

async function listKeys(bucket: string, endpoint: string, prefix?: string): Promise<string[]> {
  const s3 = client(endpoint);
  try {
    return await listKeyPages(s3, bucket, prefix);
  } catch (error) {
    if (isMissingBucket(error)) {
      return [];
    }
    throw error;
  }
}

async function listKeyPages(s3: S3Client, bucket: string, prefix?: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const item of page.Contents ?? []) {
      if (item.Key) {
        keys.push(item.Key);
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export async function deleteCurrentTestRun(input: {
  bucket: string;
  endpoint: string;
  runId: string;
}): Promise<number> {
  const bucket = assertSafeTestBucket(input.bucket);
  const prefix = testRunObjectPrefix(input.runId);
  const keys = await listKeys(bucket, input.endpoint, prefix);
  for (const key of keys) {
    assertOwnedTestPrefix(key, input.runId);
  }
  return removeKeys(bucket, input.endpoint, keys);
}

export async function emptyKnownTestBucket(input: {
  bucket: string;
  endpoint: string;
}): Promise<number> {
  if (input.bucket !== 'sgr-attachments-test') {
    throw new Error('Refusing to empty a bucket other than sgr-attachments-test');
  }
  const bucket = assertSafeTestBucket(input.bucket);
  const keys = await listKeys(bucket, input.endpoint);
  return removeKeys(bucket, input.endpoint, keys);
}
