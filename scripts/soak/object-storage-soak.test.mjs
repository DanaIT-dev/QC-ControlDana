import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeBucket, parseArgs } from './object-storage-soak.mjs';

test('soak arguments keep the preflight defaults', () => {
  const values = parseArgs([]);
  assert.equal(values.durationSeconds, 1800);
  assert.equal(values.targetEnvironment, 'CI_PREFLIGHT');
  assert.equal(values.multipartThreshold, 5 * 1024 * 1024);
  assert.equal(values.maxRetainedBytes, 256 * 1024 * 1024);
});

test('soak refuses development and test buckets', () => {
  assert.throws(() => assertSafeBucket('sgr-attachments'), /development or test bucket/);
  assert.throws(() => assertSafeBucket('sgr-attachments-test'), /development or test bucket/);
  assert.throws(() => assertSafeBucket('sgr-attachments-e2e'), /development or test bucket/);
  assert.doesNotThrow(() => assertSafeBucket('sgr-soak-preflight'));
});
