const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const RELEASE_ID = /^rc-\d{8}-[0-9a-f]{7,12}$/;

const OWN_ROLES = ['qc-api', 'qc-web', 'qc-worker', 'qc-migrator'];
const VENDOR_ROLES = ['caddy', 'postgres', 'redis', 'minio', 'clamav'];
const REQUIRED_ROLES = [...OWN_ROLES, ...VENDOR_ROLES];

const SECRET_KEY =
  /password|secret|token|credential|connectionstring|cookie|session|privatekey|api[_-]?key/i;

export function waiverApproved(statement) {
  const owner = String(statement?.riskOwner ?? '').trim();
  if (!owner || /pipeline|release engineering|unassigned|tbd/i.test(owner)) {
    return false;
  }
  return [
    statement.writtenDecision,
    statement.scope,
    statement.compensatingControls,
    statement.expiresOn,
    statement.nextReview,
    statement.revocationCriterion,
    statement.issueUrl,
  ].every((value) => String(value ?? '').trim().length > 0);
}

function reason(code, extra = {}) {
  return { code, blockingProduction: true, ...extra };
}

function walkForbiddenKeys(value, path, found) {
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      found.push(`${path}.${key}`);
    }
    walkForbiddenKeys(child, `${path}.${key}`, found);
  }
}

export function evaluateRelease(input) {
  const reasons = [];
  const blockers = [];
  const record = input?.record ?? null;
  const minioDigest = input?.minioAmd64Digest ?? null;

  if (!DIGEST.test(minioDigest ?? '')) {
    reasons.push(
      reason('MINIO_AMD64_DIGEST_UNCONFIRMED', {
        requiredAction:
          'Authorize pull scope for the official docker.io/minio/minio repository and record the linux/amd64 platform digest. Do not reuse a local arm64 image id.',
      }),
    );
  }

  for (const waiver of input?.criticalWaivers ?? []) {
    if (!waiverApproved(waiver)) {
      reasons.push(
        reason('CRITICAL_WAIVER_UNAPPROVED', {
          cve: waiver.cve,
          image: waiver.image,
        }),
      );
    }
  }

  if (!record) {
    reasons.push(reason('RELEASE_RECORD_ABSENT'));
    reasons.push(reason('STAGING_AMD64_NOT_AVAILABLE'));
    reasons.push(reason('SIGNATURES_NOT_VERIFIED'));
    reasons.push(reason('RELEASE_VEX_NOT_BOUND'));
    return finish(reasons, blockers);
  }

  const forbidden = [];
  walkForbiddenKeys(record, 'record', forbidden);
  if (forbidden.length > 0) {
    blockers.push(reason('SECRET_IN_RELEASE_RECORD', { paths: forbidden }));
  }
  if (!RELEASE_ID.test(record.releaseId ?? '')) {
    blockers.push(reason('RELEASE_ID_INVALID'));
  }
  if (!SHA.test(record.sourceCommit ?? '')) {
    blockers.push(reason('SOURCE_COMMIT_INVALID'));
  }
  if (record.targetEnvironment !== 'staging') {
    blockers.push(reason('TARGET_ENVIRONMENT_FORBIDDEN', { value: record.targetEnvironment }));
  }
  if (record.targetPlatform !== 'linux/amd64') {
    blockers.push(reason('TARGET_PLATFORM_INVALID'));
  }
  if ((record.mutableReferences ?? []).length > 0) {
    blockers.push(reason('MUTABLE_REFERENCE', { references: record.mutableReferences }));
  }
  if (record.signing?.verified !== true || record.signing?.mechanism !== 'sigstore-keyless') {
    reasons.push(reason('SIGNATURES_NOT_VERIFIED'));
  } else if (
    record.signing.oidcIssuer !== 'https://token.actions.githubusercontent.com' ||
    record.signing.repository !== 'DanaIT-dev/QC-ControlDana' ||
    !String(record.signing.workflow ?? '').endsWith(
      '.github/workflows/release-candidate.yml@refs/heads/main',
    )
  ) {
    blockers.push(reason('SIGNATURE_IDENTITY_MISMATCH'));
  }

  const staging = record.staging ?? {};
  if (staging.architecture !== 'x86_64' || staging.acceptance !== 'PASS') {
    reasons.push(
      reason('STAGING_AMD64_NOT_AVAILABLE', {
        architecture: staging.architecture ?? null,
        acceptance: staging.acceptance ?? null,
      }),
    );
  }
  if (staging.productionSeparated !== true) {
    blockers.push(reason('STAGING_PRODUCTION_SEPARATION_UNCONFIRMED'));
  }

  const images = Array.isArray(record.images) ? record.images : [];
  const byRole = new Map(images.map((image) => [image.imageRole, image]));
  for (const role of REQUIRED_ROLES) {
    if (!byRole.has(role)) {
      reasons.push(reason('IMAGE_ROLE_MISSING', { imageRole: role }));
    }
  }

  for (const image of images) {
    const label = image.imageRole ?? 'unknown';
    if (!DIGEST.test(image.registryDigest ?? '') || !DIGEST.test(image.platformDigest ?? '')) {
      reasons.push(reason('IMAGE_DIGEST_UNCONFIRMED', { imageRole: label }));
    }
    if (image.platform !== 'linux/amd64') {
      blockers.push(reason('IMAGE_PLATFORM_INVALID', { imageRole: label }));
    }
    if (image.versionTag === 'latest' || String(image.repository ?? '').endsWith(':latest')) {
      blockers.push(reason('MUTABLE_REFERENCE', { imageRole: label }));
    }
    if (!image.sbomChecksum || !DIGEST.test(image.sbomChecksum)) {
      reasons.push(reason('SBOM_MISSING', { imageRole: label }));
    }
    if (!image.openVexReference) {
      reasons.push(reason('RELEASE_VEX_NOT_BOUND', { imageRole: label }));
    }
    if (image.openVexProductDigest && image.openVexProductDigest === image.baseImageDigest) {
      blockers.push(reason('VEX_BOUND_TO_BASE_IMAGE', { imageRole: label }));
    }
    if (OWN_ROLES.includes(label)) {
      if (image.ociRevision !== record.sourceCommit) {
        blockers.push(reason('OCI_REVISION_MISMATCH', { imageRole: label }));
      }
      if (image.user !== '10001' && image.user !== 'sgr') {
        blockers.push(reason('RUNTIME_USER_INVALID', { imageRole: label }));
      }
      if (!image.provenanceReference) {
        reasons.push(reason('PROVENANCE_MISSING', { imageRole: label }));
      }
      if (image.signatureVerified !== true) {
        reasons.push(reason('SIGNATURES_NOT_VERIFIED', { imageRole: label }));
      }
      if (label !== 'qc-migrator' && (image.prismaCli === true || image.devDependencies === true)) {
        blockers.push(reason('RUNTIME_DEV_DEPENDENCY', { imageRole: label }));
      }
    }
  }

  const api = byRole.get('qc-api');
  const worker = byRole.get('qc-worker');
  if (api && worker) {
    const apiCommand = (api.command ?? []).join(' ');
    const workerCommand = (worker.command ?? []).join(' ');
    if (!apiCommand.includes('apps/api/dist/main.js')) {
      blockers.push(reason('API_COMMAND_INVALID'));
    }
    if (!workerCommand.includes('apps/worker/dist/main.js')) {
      blockers.push(reason('WORKER_COMMAND_INVALID'));
    }
    if (api.registryDigest && api.registryDigest === worker.registryDigest) {
      if (record.sharedRuntimeDigest !== api.registryDigest) {
        reasons.push(reason('SHARED_RUNTIME_DIGEST_UNDOCUMENTED'));
      }
    }
  }

  if (record.policyOpenVexIsReleaseBound === true) {
    blockers.push(reason('POLICY_VEX_USED_AS_RELEASE_VEX'));
  }

  return finish(reasons, blockers);
}

function finish(reasons, blockers) {
  const status = blockers.length > 0 ? 'BLOCKED' : reasons.length > 0 ? 'PARTIAL' : 'PASS';
  return { status, reasons, blockers };
}
