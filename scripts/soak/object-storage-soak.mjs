import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const {
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
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const protectedBuckets = new Set([
  'sgr-attachments',
  'sgr-attachments-test',
  'sgr-attachments-e2e',
]);

export function assertSafeBucket(bucket) {
  if (protectedBuckets.has(bucket) || bucket.startsWith('sgr-attachments')) {
    throw new Error('Refusing to soak a development or test bucket');
  }
}

export function parseArgs(argv) {
  const values = {
    durationSeconds: 1800,
    concurrency: 4,
    minBytes: 1024,
    maxBytes: 8 * 1024 * 1024,
    multipartThreshold: 5 * 1024 * 1024,
    restartIntervalSeconds: 600,
    maxRetainedBytes: 256 * 1024 * 1024,
    seed: 'qc-soak',
    targetEnvironment: 'CI_PREFLIGHT',
    restartContainer: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const take = () => {
      index += 1;
      return next;
    };
    if (arg === '--duration-seconds') values.durationSeconds = Number(take());
    else if (arg === '--concurrency') values.concurrency = Number(take());
    else if (arg === '--min-bytes') values.minBytes = Number(take());
    else if (arg === '--max-bytes') values.maxBytes = Number(take());
    else if (arg === '--multipart-threshold') values.multipartThreshold = Number(take());
    else if (arg === '--restart-interval-seconds') values.restartIntervalSeconds = Number(take());
    else if (arg === '--max-retained-bytes') values.maxRetainedBytes = Number(take());
    else if (arg === '--seed') values.seed = take();
    else if (arg === '--target-environment') values.targetEnvironment = take();
    else if (arg === '--restart-container') values.restartContainer = take();
  }
  if (!Number.isFinite(values.durationSeconds) || values.durationSeconds < 1) {
    throw new Error('duration must be a positive number of seconds');
  }
  return values;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function rng(seed) {
  let state = createHash('sha256').update(seed).digest().readUInt32BE(0) || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function percentile(samples, ratio) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)));
  return sorted[index];
}

async function bodyBuffer(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function runSoak(options, env = process.env) {
  const bucket = env.S3_BUCKET;
  assertSafeBucket(bucket);
  const client = new S3Client({
    region: env.S3_REGION || 'us-east-1',
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
  const send = client.send.bind(client);
  client.send = (command, commandOptions = {}) =>
    send(command, { abortSignal: AbortSignal.timeout(120_000), ...commandOptions });
  const prefix = `soak/${options.seed}/${randomUUID()}/`;
  const random = rng(options.seed);
  const started = Date.now();
  const deadline = started + options.durationSeconds * 1000;
  const metrics = {
    targetEnvironment: options.targetEnvironment,
    durationSeconds: options.durationSeconds,
    concurrency: options.concurrency,
    operationsAttempted: 0,
    operationsSucceeded: 0,
    operationsFailed: 0,
    checksumMismatches: 0,
    missingObjects: 0,
    unexpectedObjects: 0,
    orphanMultipartUploads: 0,
    publishedCorruptedObjects: 0,
    unexplainedPermanentFailures: 0,
    latenciesMs: [],
    restartRecoveryMs: [],
    containerRestarts: 0,
    healthFailures: 0,
    failureNames: {},
    backupRestoreMismatches: 0,
    maxRetainedBytes: options.maxRetainedBytes,
  };
  const retained = [];
  let retainedBytes = 0;
  let nextRestart = started + options.restartIntervalSeconds * 1000;

  async function retain(key, size) {
    retained.push({ key, size });
    retainedBytes += size;
    while (retainedBytes > options.maxRetainedBytes && retained.length > 1) {
      const oldest = retained.shift();
      retainedBytes -= oldest.size;
      await timed(() => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldest.key })));
    }
  }

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }

  async function timed(work) {
    const began = Date.now();
    metrics.operationsAttempted += 1;
    try {
      const result = await work();
      metrics.operationsSucceeded += 1;
      metrics.latenciesMs.push(Date.now() - began);
      return result;
    } catch (error) {
      metrics.operationsFailed += 1;
      const name = error?.name || 'Error';
      metrics.failureNames[name] = (metrics.failureNames[name] ?? 0) + 1;
      throw error;
    }
  }

  async function oneOperation(sequence) {
    const span = Math.max(1, options.maxBytes - options.minBytes);
    const size = options.minBytes + Math.floor(random() * span);
    const key = `${prefix}${sequence.toString(16)}`;
    const payload = Buffer.alloc(size, sequence % 251);
    const digest = createHash('sha256').update(payload).digest('hex');
    if (size >= options.multipartThreshold && random() < 0.15) {
      const created = await timed(() =>
        client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key })),
      );
      await timed(() =>
        client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: created.UploadId,
          }),
        ),
      );
      return;
    }
    if (size >= options.multipartThreshold) {
      await timed(() =>
        new Upload({
          client,
          params: {
            Bucket: bucket,
            Key: key,
            Body: payload,
            ContentType: 'application/octet-stream',
          },
          partSize: options.multipartThreshold,
        }).done(),
      );
    } else {
      await timed(() =>
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: payload,
            ContentType: 'application/octet-stream',
          }),
        ),
      );
    }
    const head = await timed(() =>
      client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
    );
    if (head.ContentLength !== size) metrics.checksumMismatches += 1;
    const object = await timed(() =>
      client.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
    );
    const bytes = await bodyBuffer(object.Body);
    if (createHash('sha256').update(bytes).digest('hex') !== digest) {
      metrics.checksumMismatches += 1;
      metrics.publishedCorruptedObjects += 1;
    }
    if (size > 2) {
      const ranged = await timed(() =>
        client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-1' })),
      );
      const rangeBytes = await bodyBuffer(ranged.Body);
      if (rangeBytes.length !== 2 || !rangeBytes.equals(payload.subarray(0, 2))) {
        metrics.checksumMismatches += 1;
      }
    }
    if (random() < 0.5) {
      await timed(() => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })));
    } else {
      await retain(key, size);
    }
  }

  async function restartIfDue() {
    if (!options.restartContainer || Date.now() < nextRestart) return;
    nextRestart = Date.now() + options.restartIntervalSeconds * 1000;
    const began = Date.now();
    const result = spawnSync('docker', ['restart', options.restartContainer], { encoding: 'utf8' });
    if (result.status !== 0) {
      metrics.healthFailures += 1;
      return;
    }
    metrics.containerRestarts += 1;
    const recoverBy = Date.now() + 60_000;
    while (Date.now() < recoverBy) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        metrics.restartRecoveryMs.push(Date.now() - began);
        return;
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
      }
    }
    metrics.healthFailures += 1;
  }

  let sequence = 0;
  let paused = false;
  async function worker() {
    while (Date.now() < deadline) {
      if (paused) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
        continue;
      }
      const current = sequence;
      sequence += 1;
      try {
        await oneOperation(current);
      } catch {
        if (!paused) metrics.unexplainedPermanentFailures += 1;
      }
    }
  }
  const supervisor = (async () => {
    while (Date.now() < deadline) {
      if (options.restartContainer && Date.now() >= nextRestart) {
        paused = true;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
        await restartIfDue();
        paused = false;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
  })();
  await Promise.all([...Array.from({ length: options.concurrency }, () => worker()), supervisor]);

  const listed = [];
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    listed.push(...(page.Contents ?? []).map((item) => item.Key).filter(Boolean));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const uploads = await client.send(
    new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }),
  );
  metrics.orphanMultipartUploads = (uploads.Uploads ?? []).length;
  const manifest = [];
  for (const key of listed) {
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = await bodyBuffer(object.Body);
      manifest.push({
        key,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } catch {
      metrics.missingObjects += 1;
    }
  }
  for (const item of manifest) {
    const copyKey = item.key.replace(prefix, `${prefix}restore/`);
    const source = await client.send(new GetObjectCommand({ Bucket: bucket, Key: item.key }));
    const bytes = await bodyBuffer(source.Body);
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: copyKey, Body: bytes }));
    const copied = await client.send(new GetObjectCommand({ Bucket: bucket, Key: copyKey }));
    const copiedBytes = await bodyBuffer(copied.Body);
    const digest = createHash('sha256').update(copiedBytes).digest('hex');
    if (digest !== item.sha256 || copiedBytes.length !== item.size)
      metrics.backupRestoreMismatches += 1;
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: copyKey }));
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.key }));
  }
  const after = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  metrics.unexpectedObjects = (after.Contents ?? []).length;
  metrics.latencyP50Ms = percentile(metrics.latenciesMs, 0.5);
  metrics.latencyP95Ms = percentile(metrics.latenciesMs, 0.95);
  metrics.latencyP99Ms = percentile(metrics.latenciesMs, 0.99);
  delete metrics.latenciesMs;
  metrics.elapsedMs = Date.now() - started;
  metrics.passed =
    metrics.checksumMismatches === 0 &&
    metrics.missingObjects === 0 &&
    metrics.unexpectedObjects === 0 &&
    metrics.publishedCorruptedObjects === 0 &&
    metrics.orphanMultipartUploads === 0 &&
    metrics.backupRestoreMismatches === 0 &&
    metrics.unexplainedPermanentFailures === 0 &&
    metrics.healthFailures === 0;
  client.destroy();
  return metrics;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  required('S3_ENDPOINT');
  required('S3_ACCESS_KEY_ID');
  required('S3_SECRET_ACCESS_KEY');
  required('S3_BUCKET');
  const metrics = await runSoak(options);
  const output = resolve('test-results/soak/object-storage-soak.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(
    JSON.stringify({
      passed: metrics.passed,
      operationsAttempted: metrics.operationsAttempted,
      operationsFailed: metrics.operationsFailed,
      checksumMismatches: metrics.checksumMismatches,
      output: 'test-results/soak/object-storage-soak.json',
    }),
  );
  if (!metrics.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.name : 'SoakFailed');
    process.exitCode = 1;
  });
}
