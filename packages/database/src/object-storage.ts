import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { AppConfig } from '@sgr-registry/config';
import type { Readable } from 'node:stream';
import { assertSafeTestBucket } from './test-bucket';

const DEFAULT_MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;
const STORAGE_TIMEOUT_MS = 5_000;
const STORAGE_ALIAS_REMOVAL = '2026-12-31';

export function readObjectStorageCredential(
  env: NodeJS.ProcessEnv,
  canonical: 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY',
  legacy: 'S3_ACCESS_KEY' | 'S3_SECRET_KEY',
): string | undefined {
  const next = env[canonical]?.trim();
  const old = env[legacy]?.trim();
  if (next && old && next !== old) {
    throw new Error(`${canonical} and ${legacy} differ`);
  }
  if (!next && old) {
    console.warn(
      `${legacy} is deprecated. Set ${canonical}. This alias will be removed after ${STORAGE_ALIAS_REMOVAL}.`,
    );
  }
  return next || old || undefined;
}

export function createS3Client(config: AppConfig): S3Client {
  const accessKeyId = config.S3_ACCESS_KEY_ID;
  const secretAccessKey = config.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Object storage credentials are not configured');
  }
  return new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    maxAttempts: 3,
    requestHandler: { requestTimeout: 60_000, connectionTimeout: STORAGE_TIMEOUT_MS },
  });
}

export function resolveAttachmentBucket(config: AppConfig): string {
  return config.NODE_ENV === 'test' ? config.S3_TEST_BUCKET : config.S3_BUCKET;
}

export class ObjectStore {
  constructor(
    private readonly client: S3Client,
    readonly bucket: string,
    private readonly multipartThresholdBytes = DEFAULT_MULTIPART_THRESHOLD_BYTES,
  ) {}

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
      abortSignal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
  }

  async ensureBucket(): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      assertSafeTestBucket(this.bucket);
    }
    try {
      await this.ping();
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }), {
        abortSignal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      });
    }
  }

  async putStream(objectKey: string, body: Readable, contentType: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      partSize: this.multipartThresholdBytes,
      params: {
        Bucket: this.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      },
    });
    try {
      await upload.done();
    } catch (error) {
      await upload.abort().catch(() => undefined);
      throw error;
    }
  }

  async putBytes(objectKey: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
      { abortSignal: AbortSignal.timeout(60_000) },
    );
  }

  async head(objectKey: string): Promise<number> {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      { abortSignal: AbortSignal.timeout(STORAGE_TIMEOUT_MS) },
    );
    return result.ContentLength ?? 0;
  }

  async getStream(objectKey: string, range?: string): Promise<GetObjectCommandOutput> {
    return this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Range: range,
      }),
      { abortSignal: AbortSignal.timeout(60_000) },
    );
  }

  async deleteExact(objectKey: string): Promise<void> {
    if (!/^(attachments|runs\/run-[0-9a-f-]{36}\/attachments)\/[0-9a-f-]{36}$/i.test(objectKey)) {
      throw new Error('Refusing to delete an object outside the attachment key format');
    }
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }), {
      abortSignal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
  }
}

export function createObjectStore(config: AppConfig): ObjectStore {
  return new ObjectStore(
    createS3Client(config),
    resolveAttachmentBucket(config),
    config.S3_MULTIPART_THRESHOLD_BYTES,
  );
}
