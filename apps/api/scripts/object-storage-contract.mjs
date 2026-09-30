import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import process from 'node:process';
import { Readable } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const endpoint = required('S3_ENDPOINT');
const region = process.env.S3_REGION || 'us-east-1';
const accessKeyId = required('S3_ACCESS_KEY_ID');
const secretAccessKey = required('S3_SECRET_ACCESS_KEY');
const bucket = required('S3_BUCKET');
const prefix = `spike/${randomUUID()}/`;
const partSize = 5 * 1024 * 1024;

if (
  bucket === 'sgr-attachments' ||
  bucket === 'sgr-attachments-test' ||
  bucket === 'sgr-attachments-e2e'
) {
  throw new Error('Refusing to run the contract harness against a development or test bucket');
}

const client = new S3Client({
  region,
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
  requestHandler: { requestTimeout: 20_000 },
});

test.before(async () => {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
});

test.after(async () => {
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const item of page.Contents ?? []) {
      if (item.Key?.startsWith(prefix)) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key }));
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  client.destroy();
});

test('credentials can reach the bucket and anonymous or wrong keys are rejected', async () => {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  await expectRejected(clientWithout('anon-access', 'anon-secret'));
  await expectRejected(clientWithout('wrong-access-key', secretAccessKey));
  await expectRejected(clientWithout(accessKeyId, 'wrong-secret-value'));
});

test('small object round-trips bytes, type, length, and checksum', async () => {
  const key = objectKey();
  const body = Buffer.from('%PDF-1.7 contract');
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/pdf',
      Metadata: { source: 'qc-contract' },
    }),
  );
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  assert.equal(head.ContentLength, body.length);
  assert.equal(head.ContentType, 'application/pdf');
  assert.equal(head.Metadata?.source, 'qc-contract');
  assert.ok(head.ETag);
  const got = await readBody(key);
  assert.equal(sha256(got), sha256(body));
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  await assertMissing(key);
});

test('object keys stay independent of the original filename', async () => {
  const filename = `${'Акт '.repeat(20)}"черновик".pdf`;
  const safeName = normalizeFilename(filename);
  assert.match(safeName, /Акт/);
  assert.equal(safeName.includes('"'), true);
  assert.equal(normalizeFilename('a\u0000b\r\n/../c').includes('\u0000'), false);
  assert.throws(() => assertProductKey('../attachments/secret'));
  const key = objectKey();
  assertProductKey(key);
  assert.equal(key.includes(filename), false);
  assert.equal(key.includes(safeName), false);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from('name'),
      ContentType: 'application/pdf',
    }),
  );
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  assert.equal(head.ContentLength, 4);
});

test('multipart upload, checksum, abort, and cancellation leave no readable orphan', async () => {
  const key = objectKey();
  const body = Buffer.alloc(partSize + 1024, 7);
  const upload = new Upload({
    client,
    partSize,
    queueSize: 2,
    params: {
      Bucket: bucket,
      Key: key,
      Body: Readable.from(body),
      ContentType: 'application/pdf',
    },
  });
  await upload.done();
  const stored = await readBody(key);
  assert.equal(stored.length, body.length);
  assert.equal(sha256(stored), sha256(body));

  const orphan = objectKey();
  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: orphan,
      ContentType: 'application/pdf',
    }),
  );
  const uploadId = created.UploadId;
  assert.ok(uploadId);
  await client.send(
    new UploadPartCommand({
      Bucket: bucket,
      Key: orphan,
      UploadId: uploadId,
      PartNumber: 1,
      Body: Buffer.alloc(partSize, 1),
    }),
  );
  await client.send(
    new AbortMultipartUploadCommand({ Bucket: bucket, Key: orphan, UploadId: uploadId }),
  );
  const listed = await client.send(
    new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: orphan }),
  );
  assert.equal((listed.Uploads ?? []).length, 0);
  await assertMissing(orphan);

  const cancelled = objectKey();
  const hanging = new Upload({
    client,
    partSize,
    params: {
      Bucket: bucket,
      Key: cancelled,
      Body: Readable.from(Buffer.alloc(partSize + 32, 3)),
      ContentType: 'application/pdf',
    },
  });
  const pending = hanging.done();
  await hanging.abort();
  await pending.catch(() => undefined);
  await assertMissing(cancelled);
});

test('range and streaming download do not require the whole object first', async () => {
  const key = objectKey();
  const body = Buffer.concat([Buffer.from('PDF!'), Buffer.alloc(64 * 1024, 9)]);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/pdf',
    }),
  );
  const ranged = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-3' }),
  );
  assert.match(ranged.ContentRange ?? '', /^bytes 0-3\//);
  const rangeBytes = Buffer.from(await ranged.Body.transformToByteArray());
  assert.equal(rangeBytes.toString('utf8'), 'PDF!');
  const full = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  assert.ok(full.Body instanceof Readable || typeof full.Body?.transformToWebStream === 'function');
  const digest = createHash('sha256');
  let largestChunk = 0;
  for await (const chunk of asReadable(full.Body)) {
    largestChunk = Math.max(largestChunk, chunk.length);
    digest.update(chunk);
  }
  assert.equal(digest.digest('hex'), sha256(body));
  assert.ok(largestChunk < body.length);
});

test('an unreachable endpoint fails instead of hanging', async () => {
  const dead = new S3Client({
    region,
    endpoint: 'http://127.0.0.1:9',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
    requestHandler: { requestTimeout: 500, connectionTimeout: 500 },
  });
  const started = Date.now();
  await assert.rejects(dead.send(new HeadBucketCommand({ Bucket: bucket })));
  assert.ok(Date.now() - started < 10_000);
  dead.destroy();
});

test('clamd handoff keeps a clean object and removes an infected one', async () => {
  const cleanKey = objectKey();
  const clean = Buffer.from('%PDF-1.7 safe');
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: cleanKey,
      Body: clean,
      ContentType: 'application/pdf',
    }),
  );
  const cleanScan = await scanBytes(clean);
  assert.equal(cleanScan.clean, true);
  assert.equal((await readBody(cleanKey)).equals(clean), true);

  const infectedKey = objectKey();
  const eicar = Buffer.from(
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
  );
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: infectedKey,
      Body: eicar,
      ContentType: 'application/pdf',
    }),
  );
  const infected = await scanBytes(eicar);
  assert.equal(infected.clean, false);
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: infectedKey }));
  await assertMissing(infectedKey);

  const malformedKey = objectKey();
  const malformed = Buffer.from([0x00, 0xff, 0x10, 0x20]);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: malformedKey,
      Body: malformed,
      ContentType: 'application/octet-stream',
    }),
  );
  const malformedScan = await scanBytes(malformed);
  assert.equal(typeof malformedScan.clean, 'boolean');
  await assert.rejects(scanBytes(malformed, { host: '127.0.0.1', port: 9, timeoutMs: 500 }));
  const stillThere = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: malformedKey }),
  );
  assert.equal(stillThere.ContentLength, malformed.length);
});

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function objectKey() {
  return `${prefix}attachments/${randomUUID()}`;
}

function assertProductKey(key) {
  if (!/^spike\/[0-9a-f-]{36}\/attachments\/[0-9a-f-]{36}$/i.test(key)) {
    throw new Error('Refusing an object key outside the attachment format');
  }
}

function normalizeFilename(raw) {
  return [...raw.normalize('NFC')]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 180);
}

function clientWithout(access, secret) {
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: access, secretAccessKey: secret },
    maxAttempts: 1,
  });
}

async function expectRejected(other) {
  await assert.rejects(other.send(new HeadBucketCommand({ Bucket: bucket })));
  other.destroy();
}

async function readBody(key) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await result.Body.transformToByteArray());
}

async function assertMissing(key) {
  await assert.rejects(
    client.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
    (error) =>
      error.name === 'NoSuchKey' ||
      error.name === 'NotFound' ||
      error.$metadata?.httpStatusCode === 404,
  );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function asReadable(body) {
  if (body instanceof Readable) {
    return body;
  }
  return Readable.fromWeb(body.transformToWebStream());
}

function scanBytes(bytes, target = {}) {
  const host = target.host ?? process.env.CLAMD_HOST ?? '127.0.0.1';
  const port = target.port ?? Number(process.env.CLAMD_PORT ?? 3310);
  const timeoutMs = target.timeoutMs ?? 8000;
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const chunks = [];
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('ClamAV timeout'));
    });
    socket.once('error', reject);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (/OK/.test(text) && !/FOUND/.test(text)) {
        resolve({ clean: true });
        return;
      }
      resolve({ clean: false, signature: text.match(/:\s*(.+?)\s+FOUND/)?.[1] ?? 'THREAT' });
    });
    socket.connect(port, host, () => {
      socket.write('zINSTREAM\0');
      const size = Buffer.alloc(4);
      size.writeUInt32BE(bytes.length, 0);
      socket.write(size);
      socket.write(bytes);
      socket.write(Buffer.alloc(4));
      socket.end();
    });
  });
}
