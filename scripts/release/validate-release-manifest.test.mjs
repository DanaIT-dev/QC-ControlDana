import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateReleaseManifest } from './validate-release-manifest.mjs';

const digest = (seed) => `sha256:${createHash('sha256').update(seed).digest('hex')}`;

function manifest(extra = {}) {
  return {
    releaseId: 'rc-20260930-aaaaaaaaaaaa',
    sourceCommit: 'a'.repeat(40),
    sourceRepository: 'https://github.com/DanaIT-dev/QC-ControlDana',
    createdAt: '2026-09-30T12:00:00Z',
    targetEnvironment: 'staging',
    targetPlatform: 'linux/amd64',
    deployable: false,
    mutableReferences: [],
    images: [
      {
        imageRole: 'qc-api',
        repository: 'ghcr.io/danait-dev/qc-controldana/qc-api',
        versionTag: 'rc-20260930-aaaaaaaaaaaa',
        registryDigest: digest('api'),
        platformDigest: digest('api-platform'),
        baseImageDigest: digest('node'),
        sbomChecksum: digest('sbom'),
        provenanceReference: 'actions:provenance',
        signatureReference: 'sigstore:api',
        openVexReference: 'oci:vex',
        scanDatabaseUpdatedAt: '2026-09-30T00:00:00Z',
        scanSummary: { critical: 0, high: 1 },
      },
    ],
    ...extra,
  };
}

test('accepts a non-deployable staging manifest', () => {
  assert.deepEqual(validateReleaseManifest(manifest()), []);
});

test('rejects a deployable manifest without a confirmed MinIO digest', () => {
  const errors = validateReleaseManifest(manifest({ deployable: true }));
  assert.ok(errors.some((error) => error.includes('MinIO')));
});

test('rejects latest and secret fields', () => {
  const document = manifest();
  document.images[0].versionTag = 'latest';
  document.sessionCookie = 'nope';
  const errors = validateReleaseManifest(document);
  assert.ok(errors.some((error) => error.includes('latest')));
  assert.ok(errors.some((error) => error.includes('forbidden')));
});
