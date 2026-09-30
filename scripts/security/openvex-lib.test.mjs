import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDecisions, validateOpenVex } from './openvex-lib.mjs';
import { coversFinding } from './supply-chain.mjs';

test('rejects not_affected without a justification', () => {
  const errors = validateOpenVex({
    statements: [
      {
        vulnerability: { name: 'CVE-2026-84782' },
        products: [{ '@id': 'pkg:oci/example@sha256:' + 'ab'.repeat(32) }],
        status: 'not_affected',
        impact_statement: 'DTLS is not used by any production listener in this image.',
      },
    ],
  });
  assert.ok(errors.some((error) => error.includes('justification')));
});

test('rejects a product that is only a tag', () => {
  const errors = validateOpenVex({
    statements: [
      {
        vulnerability: { name: 'CVE-2026-84782' },
        products: [{ '@id': 'pkg:oci/example@2-alpine' }],
        status: 'not_affected',
        justification: 'vulnerable_code_not_in_execute_path',
        impact_statement: 'DTLS is not used by any production listener in this image.',
      },
    ],
  });
  assert.ok(errors.some((error) => error.includes('digest')));
});

test('does not let a userland rule hide an unauthenticated write', () => {
  const cover = coversFinding(
    {
      statements: [],
      packageRules: [
        {
          images: ['minio'],
          packages: ['github.com/minio/minio'],
          status: 'NOT_AFFECTED',
          justification: 'vulnerable_code_not_in_execute_path',
          impact: 'unused',
          evidence: 'unused',
        },
      ],
    },
    'minio',
    {
      cve: 'CVE-2026-40344',
      package: 'github.com/minio/minio',
      title: 'Unauthenticated object write',
      target: 'usr/bin/minio',
    },
  );
  assert.equal(cover, null);
});

test('temporary acceptance must name evidence and a review date', () => {
  const errors = validateDecisions({
    statements: [
      {
        status: 'ACCEPTED_TEMPORARILY',
        impact: '',
        evidence: '',
      },
    ],
  });
  assert.ok(errors.length > 0);
});
