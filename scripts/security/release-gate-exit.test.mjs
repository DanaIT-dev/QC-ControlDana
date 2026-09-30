import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseGateExitCode } from './release-gate-exit.mjs';

test('publish mode rejects a partial gate', () => {
  assert.equal(releaseGateExitCode('PARTIAL', 'publish'), 1);
  assert.equal(releaseGateExitCode('BLOCKED', 'publish'), 1);
  assert.equal(releaseGateExitCode('PASS', 'publish'), 0);
});

test('audit mode keeps a partial gate non-zero only for a block', () => {
  assert.equal(releaseGateExitCode('PARTIAL', 'audit'), 0);
  assert.equal(releaseGateExitCode('BLOCKED', 'audit'), 1);
});
