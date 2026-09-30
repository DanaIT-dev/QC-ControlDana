import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { evaluateRelease, waiverApproved } from './evaluate-release.mjs';

const digest = (seed) => `sha256:${createHash('sha256').update(seed).digest('hex')}`;
const storagePass = {
  objectStorageAmd64Digest: digest('object-storage'),
  objectStorageContract: 'PASS',
  objectStorageBackupRestore: 'PASS',
  objectStorageLicenseReviewed: true,
  objectStorageSbomPresent: true,
  objectStorageVexBound: true,
};
const source = 'a'.repeat(40);

function image(role, extra = {}) {
  const own = role.startsWith('qc-');
  return {
    imageRole: role,
    repository: `ghcr.io/danait-dev/qc-controldana/${role}`,
    versionTag: 'rc-20260930-aaaaaaaaaaaa',
    registryDigest: digest(`registry:${role}`),
    platformDigest: digest(`platform:${role}`),
    platform: 'linux/amd64',
    baseImageDigest: digest('base'),
    ociRevision: own ? source : undefined,
    user: own ? '10001' : 'root',
    command:
      role === 'qc-api'
        ? ['node', 'apps/api/dist/main.js']
        : role === 'qc-worker'
          ? ['node', 'apps/worker/dist/main.js']
          : role === 'qc-web'
            ? ['node', 'apps/web/server.js']
            : ['migrate'],
    sbomChecksum: digest('sbom'),
    provenanceReference: own ? 'oci:provenance' : undefined,
    signatureVerified: own ? true : undefined,
    openVexReference: `oci:vex:${role}`,
    openVexProductDigest: digest(role.replace(/[^a-z]/g, '').slice(0, 4) || 'abcd'),
    prismaCli: role === 'qc-migrator',
    devDependencies: false,
    ...extra,
  };
}

function completeRecord() {
  const runtimeDigest = digest('runtime');
  return {
    releaseId: 'rc-20260930-aaaaaaaaaaaa',
    sourceCommit: source,
    targetEnvironment: 'staging',
    targetPlatform: 'linux/amd64',
    mutableReferences: [],
    sharedRuntimeDigest: runtimeDigest,
    policyOpenVexIsReleaseBound: false,
    signing: {
      verified: true,
      mechanism: 'sigstore-keyless',
      oidcIssuer: 'https://token.actions.githubusercontent.com',
      repository: 'DanaIT-dev/QC-ControlDana',
      workflow:
        'https://github.com/DanaIT-dev/QC-ControlDana/.github/workflows/release-candidate.yml@refs/heads/main',
    },
    staging: {
      architecture: 'x86_64',
      acceptance: 'PASS',
      productionSeparated: true,
    },
    images: [
      image('qc-api', { registryDigest: runtimeDigest, openVexProductDigest: runtimeDigest }),
      image('qc-web'),
      image('qc-worker', { registryDigest: runtimeDigest, openVexProductDigest: runtimeDigest }),
      image('qc-migrator'),
      image('caddy'),
      image('postgres'),
      image('redis'),
      image('object-storage'),
      image('clamav'),
    ],
  };
}

test('an absent release record is PARTIAL and blocks production', () => {
  const result = evaluateRelease({ objectStorageAmd64Digest: null, record: null });
  assert.equal(result.status, 'PARTIAL');
  assert.ok(result.reasons.some((item) => item.code === 'OBJECT_STORAGE_AMD64_DIGEST_CONFIRMED'));
  assert.ok(result.reasons.some((item) => item.code === 'STAGING_AMD64_NOT_AVAILABLE'));
  assert.ok(result.reasons.every((item) => item.blockingProduction === true));
});

test('an unapproved critical waiver cannot PASS', () => {
  const result = evaluateRelease({
    ...storagePass,
    record: completeRecord(),
    criticalWaivers: [{ cve: 'CVE-2026-6653', image: 'clamav', status: 'ACCEPTED_TEMPORARILY' }],
  });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.reasons[0].code, 'CRITICAL_WAIVER_UNAPPROVED');
  assert.equal(result.reasons[0].cve, 'CVE-2026-6653');
});

test('a complete signed amd64 staging record can PASS', () => {
  const result = evaluateRelease({
    ...storagePass,
    record: completeRecord(),
    criticalWaivers: [
      {
        cve: 'CVE-2026-6653',
        image: 'clamav',
        riskOwner: 'Named owner',
        writtenDecision: 'Accepted for isolated staging only',
        scope: 'clamav document parsing',
        compensatingControls: 'internal network, size limit, restart',
        expiresOn: '2026-10-30',
        nextReview: '2026-10-30',
        revocationCriterion: 'official fixed digest',
        issueUrl: 'https://example.invalid/risk/1',
      },
    ],
  });
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.status, 'PASS');
});

test('qemu or arm64 staging cannot PASS', () => {
  const record = completeRecord();
  record.staging.architecture = 'aarch64';
  const result = evaluateRelease({ ...storagePass, record });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.reasons[0].code, 'STAGING_AMD64_NOT_AVAILABLE');
});

test('a release pipeline cannot approve its own critical waiver', () => {
  assert.equal(
    waiverApproved({
      riskOwner: 'release engineering',
      writtenDecision: 'yes',
      scope: 'clamav',
      compensatingControls: 'limits',
      expiresOn: '2026-10-30',
      nextReview: '2026-10-30',
      revocationCriterion: 'fixed digest',
      issueUrl: 'https://example.invalid/risk/1',
    }),
    false,
  );
});

test('a secret field blocks the record', () => {
  const record = completeRecord();
  record.databasePassword = 'hidden';
  const result = evaluateRelease({ ...storagePass, record });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.blockers[0].code, 'SECRET_IN_RELEASE_RECORD');
});
