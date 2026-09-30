import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseStatement } from './render-release-vex.mjs';

const finalDigest = `sha256:${'ab'.repeat(32)}`;
const baseDigest = `sha256:${'cd'.repeat(32)}`;

function assessment(extra = {}) {
  return {
    cve: 'CVE-2026-6653',
    repository: 'ghcr.io/danait-dev/qc-controldana/qc-api',
    productDigest: finalDigest,
    baseImageDigest: baseDigest,
    status: 'affected',
    impactStatement:
      'ClamAV can parse an uploaded document with libxml2. The path is reachable from an authenticated upload.',
    evidence: 'Worker scan path calls clamd. Caddy limits the body to 22MB.',
    assessedAt: '2026-09-30T00:00:00Z',
    assessor: 'trivy 0.66.0 plus runtime review',
    nextReview: '2026-10-30',
    remediationCondition:
      'Replace the image when an official fixed linux/amd64 digest is published.',
    ...extra,
  };
}

test('binds the statement to the final registry digest', () => {
  const rendered = releaseStatement(assessment());
  assert.deepEqual(rendered.errors, []);
  assert.equal(
    rendered.statement.products[0]['@id'],
    `ghcr.io/danait-dev/qc-controldana/qc-api@${finalDigest}`,
  );
});

test('rejects a statement copied from the base image', () => {
  const rendered = releaseStatement(
    assessment({
      copiedFromBase: true,
      status: 'not_affected',
      justification: 'vulnerable_code_not_in_execute_path',
      runtimePathChecked: true,
    }),
  );
  assert.ok(rendered.errors.some((error) => error.includes('base-image')));
});

test('rejects NOT_AFFECTED without a final-image runtime path check', () => {
  const rendered = releaseStatement(
    assessment({
      status: 'not_affected',
      justification: 'vulnerable_code_not_in_execute_path',
    }),
  );
  assert.ok(rendered.errors.some((error) => error.includes('runtime path')));
});

test('rejects a product id that is only the base digest', () => {
  const rendered = releaseStatement(assessment({ productDigest: baseDigest }));
  assert.ok(rendered.errors.some((error) => error.includes('base image digest')));
});
