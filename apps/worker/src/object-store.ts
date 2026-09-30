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
import { assertSafeTestBucket } from '@sgr-registry/database';
import type { Readable } from 'node:stream';

export function createS3Client(config: AppConfig): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  });
}

export function resolveAttachmentBucket(config: AppConfig): string {
  return config.NODE_ENV === 'test' ? config.S3_TEST_BUCKET : config.S3_BUCKET;
}

export class ObjectStore {
  constructor(
    private readonly client: S3Client,
    readonly bucket: string,
  ) {}

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async ensureBucket(): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      assertSafeTestBucket(this.bucket);
    }
    try {
      await this.ping();
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async putStream(objectKey: string, body: Readable, contentType: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      },
    });
    await upload.done();
  }

  async putBytes(objectKey: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async head(objectKey: string): Promise<number> {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
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
    );
  }

  async deleteExact(objectKey: string): Promise<void> {
    if (!/^(attachments|runs\/run-[0-9a-f-]{36}\/attachments)\/[0-9a-f-]{36}$/i.test(objectKey)) {
      throw new Error('Refusing to delete an object outside the attachment key format');
    }
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }
}
