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
const probePath = resolve(releaseDir, 'minio-probe.json');
const probe = existsSync(probePath) ? JSON.parse(readFileSync(probePath, 'utf8')) : null;
const recordPath = resolve(releaseDir, 'record.json');
const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
const criticalWaivers = (decisions.statements ?? []).filter(
  (statement) => statement.status === 'ACCEPTED_TEMPORARILY' && statement.cve === 'CVE-2026-6653',
);

const result = evaluateRelease({
  minioAmd64Digest: probe?.linuxAmd64Digest ?? null,
  record,
  criticalWaivers,
});
mkdirSync(releaseDir, { recursive: true });
const summary = {
  ...result,
  productionDeployment: 'NOT_STARTED',
  minioAmd64Confirmed: Boolean(probe?.amd64Confirmed),
};
writeFileSync(resolve(releaseDir, 'gate.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exit(result.status === 'BLOCKED' ? 1 : result.status === 'PARTIAL' ? 2 : 0);
