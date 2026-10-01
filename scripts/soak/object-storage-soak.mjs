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

const protectedVolumes = new Set([
  'docker_sgr_registry_minio',
  'docker_sgr_registry_object_storage',
  'sgr_registry_object_storage',
  'sgr_object_storage',
  'sgr_staging_object_storage',
]);

const defaultBudget = {
  maxLiveObjects: 500,
  maxLiveBytes: 256 * 1024 * 1024,
  maxVolumeBytes: 2 * 1024 * 1024 * 1024,
  minFreeDiskBytes: 10 * 1024 * 1024 * 1024,
  retentionBatchSize: 25,
  emergencyStopPercent: 90,
};

export function assertSafeBucket(bucket) {
  if (protectedBuckets.has(bucket) || bucket.startsWith('sgr-attachments')) {
    throw new Error('Refusing to soak a development or test bucket');
  }
}

export function assertSoakBudget(values) {
  for (const key of Object.keys(defaultBudget)) {
    const value = values[key];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${key} is a required finite limit`);
    }
  }
  if (values.emergencyStopPercent >= 100) {
    throw new Error('emergencyStopPercent must stay below 100');
  }
}

export function budgetState(input) {
  const ratios = [
    input.liveObjects / input.maxLiveObjects,
    input.liveBytes / input.maxLiveBytes,
    input.volumeBytes / input.maxVolumeBytes,
  ];
  const peakRatio = Math.max(...ratios);
  const diskBlocked = input.freeDiskBytes < input.minFreeDiskBytes;
  return {
    peakRatio,
    warn: !diskBlocked && peakRatio >= 0.8 && peakRatio < input.emergencyStopPercent / 100,
    stop: diskBlocked || peakRatio >= input.emergencyStopPercent / 100,
  };
}

const protectedContainers = new Set(['sgr-registry-object-storage', 'sgr-registry-minio']);

export function assertSoakContainer(name, labels = {}) {
  if (protectedContainers.has(name)) {
    throw new Error('Refusing to clean a development container');
  }
  const purpose = labels['qc.purpose'];
  if (purpose !== 'soak' && purpose !== 'disposable-storage-spike') {
    throw new Error('Container is missing an explicit soak label');
  }
}

export function assertDisposableVolume(name, labels = {}) {
  if (protectedVolumes.has(name)) {
    throw new Error('Refusing to use a development or legacy volume');
  }
  const purpose = labels['qc.purpose'];
  if (purpose !== 'soak' && purpose !== 'disposable-storage-spike') {
    throw new Error('Volume is missing an explicit soak label');
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
    volume: '',
    container: '',
    intervalMs: 0,
    ...defaultBudget,
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
    else if (arg === '--volume') values.volume = take();
    else if (arg === '--container') values.container = take();
    else if (arg === '--max-live-objects') values.maxLiveObjects = Number(take());
    else if (arg === '--max-live-bytes') values.maxLiveBytes = Number(take());
    else if (arg === '--max-volume-bytes') values.maxVolumeBytes = Number(take());
    else if (arg === '--min-free-disk-bytes') values.minFreeDiskBytes = Number(take());
    else if (arg === '--retention-batch-size') values.retentionBatchSize = Number(take());
    else if (arg === '--emergency-stop-percent') values.emergencyStopPercent = Number(take());
    else if (arg === '--interval-ms') values.intervalMs = Number(take());
  }
  if (!Number.isFinite(values.durationSeconds) || values.durationSeconds < 1) {
    throw new Error('duration must be a positive number of seconds');
  }
  assertSoakBudget(values);
  return values;
}

export function parseDockerSize(value) {
  const match = /^([\d.]+)([kMG]?)B$/.exec(String(value).trim());
  if (!match) {
    return null;
  }
  const number = Number(match[1]);
  const factor =
    match[2] === 'G' ? 1024 ** 3 : match[2] === 'M' ? 1024 ** 2 : match[2] === 'k' ? 1024 : 1;
  return Number.isFinite(number) ? Math.round(number * factor) : null;
}

export function volumeBytesFromDf(text, name) {
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === name) {
      return parseDockerSize(parts.at(-1));
    }
  }
  return null;
}

export function pruneSoakTrash(container) {
  const inspected = spawnSync(
    'docker',
    ['inspect', '--format', '{{json .Config.Labels}}', container],
    { encoding: 'utf8' },
  );
  if (inspected.status !== 0) {
    throw new Error('Cannot inspect soak container');
  }
  assertSoakContainer(container, JSON.parse(inspected.stdout || '{}') ?? {});
  const removed = spawnSync(
    'docker',
    ['exec', container, 'sh', '-c', 'rm -rf /data/.rustfs.sys/tmp/.trash'],
    { encoding: 'utf8' },
  );
  if (removed.status !== 0) {
    throw new Error('Cannot prune soak trash');
  }
}

export function readVolumeBytes(name) {
  const result = spawnSync('docker', ['system', 'df', '-v'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('Cannot read Docker volume size');
  }
  const bytes = volumeBytesFromDf(result.stdout, name);
  if (bytes === null) {
    throw new Error('Cannot read Docker volume size');
  }
  return bytes;
}

export function readFreeDiskBytes(path = '.') {
  const result = spawnSync('df', ['-k', path], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('Cannot read free disk space');
  }
  const line = result.stdout.trim().split('\n').at(-1) ?? '';
  const available = Number(line.trim().split(/\s+/)[3]);
  if (!Number.isFinite(available)) {
    throw new Error('Cannot read free disk space');
  }
  return available * 1024;
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

export async function runSoak(options, env = process.env, hooks = {}) {
  assertSoakBudget(options);
  if (options.volume) {
    assertDisposableVolume(options.volume, hooks.volumeLabels ?? {});
  }
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
    failureSamples: [],
    backupRestoreMismatches: 0,
    maxRetainedBytes: options.maxRetainedBytes,
    maxLiveObjects: options.maxLiveObjects,
    maxLiveBytes: options.maxLiveBytes,
    maxVolumeBytes: options.maxVolumeBytes,
    minFreeDiskBytes: options.minFreeDiskBytes,
    retentionBatchSize: options.retentionBatchSize,
    emergencyStopPercent: options.emergencyStopPercent,
    peakLiveObjects: 0,
    peakLiveBytes: 0,
    peakVolumeBytes: 0,
    budgetWarnings: 0,
    emergencyStop: false,
    freeDiskBytesBefore: 0,
    freeDiskBytesAfter: 0,
    cleanupResult: 'not-run',
  };
  const retained = [];
  let retainedBytes = 0;
  let incompleteMultipart = 0;
  let budgetStop = false;
  let nextRestart = started + options.restartIntervalSeconds * 1000;
  const freeDisk = hooks.readFreeDiskBytes ?? readFreeDiskBytes;
  metrics.freeDiskBytesBefore = freeDisk();
  if (metrics.freeDiskBytesBefore < options.minFreeDiskBytes) {
    throw new Error('Free disk is below the soak minimum');
  }

  function currentBudget() {
    const state = budgetState({
      liveObjects: retained.length + incompleteMultipart,
      liveBytes: retainedBytes,
      volumeBytes: retainedBytes,
      freeDiskBytes: metrics.freeDiskBytesBefore,
      ...options,
    });
    metrics.peakLiveObjects = Math.max(
      metrics.peakLiveObjects,
      retained.length + incompleteMultipart,
    );
    metrics.peakLiveBytes = Math.max(metrics.peakLiveBytes, retainedBytes);
    if (state.warn) metrics.budgetWarnings += 1;
    if (state.stop) budgetStop = true;
    return state;
  }

  async function retain(key, size) {
    retained.push({ key, size });
    retainedBytes += size;
    const byteLimit = Math.min(options.maxRetainedBytes, Math.floor(options.maxLiveBytes * 0.7));
    const objectLimit = Math.max(1, Math.floor(options.maxLiveObjects * 0.7));
    while ((retainedBytes > byteLimit || retained.length > objectLimit) && retained.length > 1) {
      const batch = retained.splice(0, Math.min(options.retentionBatchSize, retained.length - 1));
      for (const oldest of batch) {
        retainedBytes -= oldest.size;
        await timed(() =>
          client.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldest.key })),
        );
      }
    }
    currentBudget();
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
      if (!paused) {
        metrics.operationsFailed += 1;
        const name = error?.name || 'Error';
        metrics.failureNames[name] = (metrics.failureNames[name] ?? 0) + 1;
        if (metrics.failureSamples.length < 8) {
          metrics.failureSamples.push({
            name,
            code: error?.Code || error?.code || error?.$metadata?.httpStatusCode || '',
            message: String(error?.message || error || '').slice(0, 180),
          });
        }
      }
      throw error;
    }
  }

  async function oneOperation(sequence) {
    if (currentBudget().stop) {
      budgetStop = true;
      return;
    }
    const span = Math.max(1, options.maxBytes - options.minBytes);
    const size = options.minBytes + Math.floor(random() * span);
    const key = `${prefix}${sequence.toString(16)}`;
    const payload = Buffer.alloc(size, sequence % 251);
    const digest = createHash('sha256').update(payload).digest('hex');
    const minimumPartBytes = 5 * 1024 * 1024;
    if (size >= minimumPartBytes && size >= options.multipartThreshold && random() < 0.15) {
      incompleteMultipart += 1;
      currentBudget();
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
      incompleteMultipart = Math.max(0, incompleteMultipart - 1);
      return;
    }
    if (size >= minimumPartBytes && size >= options.multipartThreshold) {
      await timed(() =>
        new Upload({
          client,
          params: {
            Bucket: bucket,
            Key: key,
            Body: payload,
            ContentType: 'application/octet-stream',
          },
          partSize: Math.max(options.multipartThreshold, minimumPartBytes),
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
    while (Date.now() < deadline && !budgetStop) {
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
      if (options.intervalMs > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, options.intervalMs));
      }
    }
  }
  const supervisor = (async () => {
    let lastVolumeCheck = 0;
    while (Date.now() < deadline && !budgetStop) {
      if (options.volume && Date.now() - lastVolumeCheck > 3_000) {
        lastVolumeCheck = Date.now();
        let volumeBytes = readVolumeBytes(options.volume);
        metrics.peakVolumeBytes = Math.max(metrics.peakVolumeBytes ?? 0, volumeBytes);
        if (options.container && volumeBytes >= options.maxVolumeBytes * 0.5) {
          paused = true;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
          pruneSoakTrash(options.container);
          volumeBytes = readVolumeBytes(options.volume);
          metrics.peakVolumeBytes = Math.max(metrics.peakVolumeBytes, volumeBytes);
          paused = false;
        }
        const state = budgetState({
          liveObjects: retained.length + incompleteMultipart,
          liveBytes: retainedBytes,
          volumeBytes,
          freeDiskBytes: metrics.freeDiskBytesBefore,
          ...options,
        });
        if (state.warn) metrics.budgetWarnings += 1;
        if (state.stop) budgetStop = true;
      }
      if (options.restartContainer && Date.now() >= nextRestart) {
        paused = true;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
        await restartIfDue();
        paused = false;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
  })();
  try {
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
    metrics.emergencyStop = budgetStop;
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
      metrics.healthFailures === 0 &&
      !metrics.emergencyStop;
  } catch {
    metrics.unexplainedPermanentFailures += 1;
    metrics.passed = false;
  } finally {
    try {
      let cleanupToken;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: cleanupToken,
          }),
        );
        for (const item of page.Contents ?? []) {
          if (!item.Key?.startsWith(prefix)) continue;
          try {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key }));
          } catch {
            metrics.cleanupResult = 'prefix-delete-incomplete';
          }
        }
        cleanupToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (cleanupToken);
    } catch {
      metrics.cleanupResult = 'prefix-delete-incomplete';
    }
    if (options.container) {
      try {
        pruneSoakTrash(options.container);
      } catch {
        metrics.cleanupResult = 'prefix-delete-incomplete';
      }
    }
    metrics.freeDiskBytesAfter = freeDisk();
    if (metrics.cleanupResult === 'not-run') metrics.cleanupResult = 'prefix-deleted';
    client.destroy();
  }
  return metrics;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  required('S3_ENDPOINT');
  required('S3_ACCESS_KEY_ID');
  required('S3_SECRET_ACCESS_KEY');
  required('S3_BUCKET');
  const volumeLabels = {};
  if (options.volume) {
    const inspected = spawnSync(
      'docker',
      ['volume', 'inspect', '--format', '{{json .Labels}}', options.volume],
      { encoding: 'utf8' },
    );
    if (inspected.status !== 0) {
      throw new Error('Cannot inspect soak volume');
    }
    Object.assign(volumeLabels, JSON.parse(inspected.stdout || '{}') ?? {});
  }
  const metrics = await runSoak(options, process.env, { volumeLabels });
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
