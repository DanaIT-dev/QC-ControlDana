import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDisposableVolume,
  assertSafeBucket,
  assertSoakContainer,
  assertSoakBudget,
  budgetState,
  parseArgs,
  parseDockerSize,
  volumeBytesFromDf,
} from './object-storage-soak.mjs';

test('soak arguments keep the preflight defaults', () => {
  const values = parseArgs([]);
  assert.equal(values.durationSeconds, 1800);
  assert.equal(values.targetEnvironment, 'CI_PREFLIGHT');
  assert.equal(values.multipartThreshold, 5 * 1024 * 1024);
  assert.equal(values.maxRetainedBytes, 256 * 1024 * 1024);
  assert.equal(values.maxLiveObjects, 500);
  assert.equal(values.emergencyStopPercent, 90);
  assert.ok(Number.isFinite(values.maxVolumeBytes));
  assert.ok(Number.isFinite(values.minFreeDiskBytes));
});

test('missing or unlimited soak limits are rejected', () => {
  assert.throws(
    () => assertSoakBudget({ ...parseArgs([]), maxLiveBytes: Number.POSITIVE_INFINITY }),
    /required finite limit/,
  );
  assert.throws(() => parseArgs(['--max-live-objects', '0']), /required finite limit/);
  assert.throws(() => parseArgs(['--emergency-stop-percent', '100']), /below 100/);
});

test('soak budget warns at 80 percent and stops at 90 percent', () => {
  const limits = parseArgs([]);
  const warn = budgetState({
    liveObjects: 1,
    liveBytes: Math.ceil(limits.maxLiveBytes * 0.8),
    volumeBytes: 1,
    freeDiskBytes: limits.minFreeDiskBytes,
    ...limits,
  });
  assert.equal(warn.warn, true);
  assert.equal(warn.stop, false);
  const stop = budgetState({
    liveObjects: 1,
    liveBytes: Math.ceil(limits.maxLiveBytes * 0.9),
    volumeBytes: 1,
    freeDiskBytes: limits.minFreeDiskBytes,
    ...limits,
  });
  assert.equal(stop.stop, true);
});

test('soak trash cleanup cannot target the development container', () => {
  assert.throws(
    () => assertSoakContainer('sgr-registry-object-storage', { 'qc.purpose': 'soak' }),
    /development container/,
  );
  assert.throws(() => assertSoakContainer('sgr-soak-budget', {}), /soak label/);
  assert.doesNotThrow(() => assertSoakContainer('sgr-soak-budget', { 'qc.purpose': 'soak' }));
});

test('soak cannot target the legacy MinIO volume or an unlabeled volume', () => {
  assert.throws(
    () => assertDisposableVolume('docker_sgr_registry_minio', { 'qc.purpose': 'soak' }),
    /legacy volume/,
  );
  assert.throws(() => assertDisposableVolume('sgr-soak-preflight', {}), /soak label/);
  assert.doesNotThrow(() => assertDisposableVolume('sgr-soak-preflight', { 'qc.purpose': 'soak' }));
});

test('docker volume sizes are parsed before the soak budget', () => {
  assert.equal(parseDockerSize('2GB'), 2 * 1024 ** 3);
  assert.equal(
    volumeBytesFromDf(
      'sgr-soak-budget 1 1.5GB\ndocker_sgr_registry_minio 1 39.48kB\n',
      'sgr-soak-budget',
    ),
    Math.round(1.5 * 1024 ** 3),
  );
  assert.equal(volumeBytesFromDf('docker_sgr_registry_minio 1 39.48kB\n', 'sgr-soak-budget'), null);
});

test('soak refuses development and test buckets', () => {
  assert.throws(() => assertSafeBucket('sgr-attachments'), /development or test bucket/);
  assert.throws(() => assertSafeBucket('sgr-attachments-test'), /development or test bucket/);
  assert.throws(() => assertSafeBucket('sgr-attachments-e2e'), /development or test bucket/);
  assert.doesNotThrow(() => assertSafeBucket('sgr-soak-preflight'));
});
