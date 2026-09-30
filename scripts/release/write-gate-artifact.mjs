#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRelease } from './evaluate-release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const releaseDir = resolve(root, 'artifacts/release');
const decisions = JSON.parse(
  readFileSync(resolve(root, 'docs/security/vulnerability-decisions.json'), 'utf8'),
);
const pins = JSON.parse(readFileSync(resolve(root, 'infra/docker/image-pins.json'), 'utf8'));
const acceptancePath = resolve(root, 'docs/security/object-storage-acceptance.json');
const acceptance = existsSync(acceptancePath)
  ? JSON.parse(readFileSync(acceptancePath, 'utf8'))
  : {};
const storage = pins.images['object-storage'] ?? {};
const recordPath = resolve(releaseDir, 'record.json');
const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
const criticalWaivers = (decisions.statements ?? []).filter(
  (statement) => statement.status === 'ACCEPTED_TEMPORARILY' && statement.cve === 'CVE-2026-6653',
);
const sbomPath = resolve(root, 'artifacts/supply-chain/sbom/object-storage.cdx.json');

const result = evaluateRelease({
  objectStorageAmd64Digest: storage.platforms?.['linux/amd64'] ?? null,
  objectStorageContract: acceptance.contract ?? null,
  objectStorageBackupRestore: acceptance.backupRestore ?? null,
  objectStorageLicenseReviewed: acceptance.licenseReviewed === true,
  objectStorageSbomPresent: existsSync(sbomPath),
  objectStorageVexBound: acceptance.vexBound === true,
  record,
  criticalWaivers,
});
mkdirSync(releaseDir, { recursive: true });
const summary = {
  ...result,
  productionDeployment: 'NOT_STARTED',
  objectStorageAmd64Confirmed: storage.amd64Confirmed === true,
  publication: result.status === 'PASS' ? 'ALLOWED' : 'PUBLICATION_FORBIDDEN',
};
writeFileSync(resolve(releaseDir, 'gate.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exit(result.status === 'BLOCKED' ? 1 : result.status === 'PARTIAL' ? 2 : 0);
