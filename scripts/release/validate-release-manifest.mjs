import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const RELEASE_ID = /^rc-\d{8}-[0-9a-f]{7,12}$/;
const SECRET_KEY =
  /password|secret|token|credential|connectionstring|cookie|session|privatekey|api[_-]?key/i;

const IMAGE_FIELDS = [
  'imageRole',
  'repository',
  'versionTag',
  'registryDigest',
  'platformDigest',
  'baseImageDigest',
  'sbomChecksum',
  'provenanceReference',
  'signatureReference',
  'openVexReference',
  'scanDatabaseUpdatedAt',
  'scanSummary',
];

export function validateReleaseManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['release manifest must be an object'];
  }
  if (manifest.targetEnvironment !== 'staging') {
    errors.push('targetEnvironment must be staging');
  }
  if (manifest.targetPlatform !== 'linux/amd64') {
    errors.push('targetPlatform must be linux/amd64');
  }
  if (!RELEASE_ID.test(manifest.releaseId ?? '')) {
    errors.push('releaseId must match rc-YYYYMMDD-<shortsha>');
  }
  if (!SHA.test(manifest.sourceCommit ?? '')) {
    errors.push('sourceCommit must be a 40 character git sha');
  }
  if (!manifest.sourceRepository || !manifest.createdAt) {
    errors.push('sourceRepository and createdAt are required');
  }
  if (!Array.isArray(manifest.mutableReferences) || manifest.mutableReferences.length > 0) {
    errors.push('mutableReferences must be an empty array');
  }
  if (manifest.deployable === true && manifest.objectStorageAmd64Confirmed !== true) {
    errors.push('a deployable manifest requires a confirmed object-storage linux/amd64 digest');
  }
  const images = manifest.images;
  if (!Array.isArray(images) || images.length === 0) {
    errors.push('images must be a non-empty array');
    return errors;
  }
  for (const [index, image] of images.entries()) {
    for (const field of IMAGE_FIELDS) {
      if (image[field] === undefined || image[field] === null || image[field] === '') {
        errors.push(`images[${index}].${field} is required`);
      }
    }
    if (image.versionTag === 'latest') {
      errors.push(`images[${index}] uses the mutable latest tag`);
    }
    for (const field of ['registryDigest', 'platformDigest', 'sbomChecksum']) {
      if (image[field] && !DIGEST.test(image[field])) {
        errors.push(`images[${index}].${field} is not a sha256 digest`);
      }
    }
    if (image.platform && image.platform !== 'linux/amd64') {
      errors.push(`images[${index}].platform must be linux/amd64`);
    }
    for (const key of Object.keys(image)) {
      if (SECRET_KEY.test(key)) {
        errors.push(`images[${index}] contains a forbidden field`);
      }
    }
  }
  for (const key of Object.keys(manifest)) {
    if (SECRET_KEY.test(key)) {
      errors.push('release manifest contains a forbidden field');
    }
  }
  return errors;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const target = process.argv[2] ?? resolve(root, 'artifacts/release/release-manifest.json');
  const manifest = JSON.parse(readFileSync(target, 'utf8'));
  const errors = validateReleaseManifest(manifest);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log('release manifest matches the release schema');
}

if (process.argv[1] && process.argv[1].endsWith('validate-release-manifest.mjs')) {
  main();
}
