import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waiverApproved } from '../release/evaluate-release.mjs';
import { releaseGateExitCode } from './release-gate-exit.mjs';
import { validateDecisions, validateOpenVex } from './openvex-lib.mjs';
import { coversFinding, scanFindings } from './supply-chain.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactDir = resolve(root, 'artifacts/supply-chain');
const blockers = [];
const partials = [];
const reasons = [];

function addReason(code, extra = {}) {
  const reason = { code, blockingProduction: true, ...extra };
  const key = JSON.stringify(reason);
  if (!reasons.some((item) => JSON.stringify(item) === key)) {
    reasons.push(reason);
  }
}

function block(message) {
  blockers.push(message);
}

function partial(message) {
  partials.push(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const pins = readJson(resolve(root, 'infra/docker/image-pins.json'));
const decisions = readJson(resolve(root, 'docs/security/vulnerability-decisions.json'));
const openvex = readJson(resolve(root, 'docs/security/openvex.json'));

for (const error of validateDecisions(decisions)) {
  block(error);
}
for (const error of validateOpenVex(openvex)) {
  block(error);
}

const storagePin = pins.images['object-storage'];
const storageAmd64 = storagePin?.platforms?.['linux/amd64'] ?? '';
const storageChecks = {
  OBJECT_STORAGE_AMD64_DIGEST_CONFIRMED:
    storagePin?.amd64Confirmed === true && /^sha256:[a-f0-9]{64}$/.test(storageAmd64),
  OBJECT_STORAGE_CONTRACT_PASSED: false,
  OBJECT_STORAGE_BACKUP_RESTORE_PASSED: false,
  OBJECT_STORAGE_LICENSE_REVIEWED: false,
  OBJECT_STORAGE_SBOM_PRESENT: existsSync(resolve(artifactDir, 'sbom/object-storage.cdx.json')),
  OBJECT_STORAGE_VEX_BOUND: false,
};
const acceptancePath = resolve(root, 'docs/security/object-storage-acceptance.json');
if (existsSync(acceptancePath)) {
  const acceptance = readJson(acceptancePath);
  storageChecks.OBJECT_STORAGE_CONTRACT_PASSED = acceptance.contract === 'PASS';
  storageChecks.OBJECT_STORAGE_BACKUP_RESTORE_PASSED = acceptance.backupRestore === 'PASS';
  storageChecks.OBJECT_STORAGE_LICENSE_REVIEWED = acceptance.licenseReviewed === true;
  storageChecks.OBJECT_STORAGE_VEX_BOUND =
    acceptance.vexBound === true && acceptance.linuxAmd64 === storageAmd64;
}
for (const [code, passed] of Object.entries(storageChecks)) {
  if (!passed) {
    partial(`${code} is not satisfied`);
    addReason(code);
  }
}

const compose = spawnSync('node', ['scripts/security/validate-production-compose.mjs'], {
  cwd: root,
  encoding: 'utf8',
});
if (compose.status !== 0) {
  block(compose.stderr || compose.stdout || 'production compose validation failed');
}

const vexTest = spawnSync('node', ['--test', 'scripts/security/openvex-lib.test.mjs'], {
  cwd: root,
  encoding: 'utf8',
});
if (vexTest.status !== 0) {
  block('OpenVEX validator tests failed');
}

const knownDigests = new Set();
for (const image of Object.values(pins.images)) {
  if (image.manifestList) {
    knownDigests.add(image.manifestList);
  }
  for (const digest of Object.values(image.platforms ?? {})) {
    if (digest) {
      knownDigests.add(digest);
    }
  }
  if (image.localArm64ImageId) {
    knownDigests.add(image.localArm64ImageId);
  }
}
if (JSON.stringify(openvex).includes('pkg:oci/minio@')) {
  partial('policy OpenVEX still cites the retired MinIO image');
  addReason('RELEASE_VEX_NOT_BOUND', {
    detail: 'docs/security/openvex.json still names the retired MinIO image',
  });
}

const imagesPath = resolve(artifactDir, 'images.json');
const images = existsSync(imagesPath) ? readJson(imagesPath) : null;
if (!images) {
  block('linux/amd64 image inspect is missing');
} else {
  for (const image of images.images ?? []) {
    if (image.digest) {
      knownDigests.add(
        image.digest.startsWith('sha256:') ? image.digest : `sha256:${image.digest}`,
      );
    }
    if (image.platform !== 'linux/amd64') {
      block(`${image.name} was not confirmed as linux/amd64`);
    }
    if (image.user && image.user !== '10001' && image.user !== 'sgr') {
      block(`${image.name} does not run as the non-root user`);
    }
    if (image.root === true && !image.rootJustification) {
      block(`${image.name} runs as root without justification`);
    }
    if (image.name !== 'migrator' && (image.devDependencies === true || image.prismaCli === true)) {
      block(`${image.name} runtime contains devDependencies or Prisma CLI`);
    }
    if (image.name === 'migrator' && image.prismaCli !== true) {
      block('migrator image is missing Prisma CLI');
    }
  }
  if (
    !images.images?.some((image) => image.name === 'runtime' && image.platform === 'linux/amd64')
  ) {
    block('linux/amd64 API runtime image was not built');
  }
}

const smokePath = resolve(artifactDir, 'smoke.json');
if (!existsSync(smokePath)) {
  block('image smoke result is missing');
} else {
  const smoke = readJson(smokePath);
  if (smoke.status === 'BLOCKED_BY_LOCAL_ARCHITECTURE' || smoke.status === 'LOCAL_EMULATED') {
    partial(`amd64 runtime smoke is ${smoke.status}`);
    addReason('STAGING_AMD64_NOT_AVAILABLE');
  } else if (smoke.status !== 'PASS') {
    block(`amd64 smoke did not pass: ${smoke.status}`);
  }
  if (smoke.hostArchitecture !== 'x86_64') {
    partial('local smoke is not a real x86_64 staging acceptance');
    addReason('STAGING_AMD64_NOT_AVAILABLE', {
      hostArchitecture: smoke.hostArchitecture ?? null,
    });
  }
}

const gitleaksPath = resolve(artifactDir, 'gitleaks.json');
if (!existsSync(gitleaksPath)) {
  block('Gitleaks result is missing');
} else {
  const leaks = readJson(gitleaksPath);
  const count = Array.isArray(leaks) ? leaks.length : (leaks.findings ?? []).length;
  if (count > 0) {
    block('Gitleaks found a secret');
  }
}

for (const statement of openvex.statements ?? []) {
  for (const product of statement.products ?? []) {
    const digest = product['@id']?.split('@')[1];
    if (digest && !knownDigests.has(digest)) {
      block(`OpenVEX product digest is not a known image digest`);
    }
  }
}

const trivyDir = resolve(artifactDir, 'trivy');
const reports = existsSync(trivyDir)
  ? readdirSync(trivyDir).filter((name) => name.endsWith('.json'))
  : [];
if (reports.length === 0) {
  block('Trivy scan was not run');
}

const sbomDir = resolve(artifactDir, 'sbom');
const sboms = existsSync(sbomDir)
  ? readdirSync(sbomDir).filter((name) => name.endsWith('.cdx.json'))
  : [];
const requiredSbom = [
  'api',
  'web',
  'worker',
  'migrator',
  'caddy',
  'postgres',
  'redis',
  'object-storage',
  'clamav',
];
for (const name of requiredSbom) {
  if (!sboms.includes(`${name}.cdx.json`)) {
    block(`SBOM is missing for ${name}`);
  }
}

const coveredCritical = new Set(
  (openvex.statements ?? []).map((statement) => statement.vulnerability?.name),
);
let criticalCount = 0;
let highCount = 0;
let applicableHigh = 0;

for (const fileName of reports) {
  const report = readJson(resolve(trivyDir, fileName));
  if (
    report.Metadata?.OS?.Family === undefined &&
    (report.Results ?? []).length === 0 &&
    report.error
  ) {
    block('Trivy vulnerability database is unavailable');
  }
  const imageName = fileName.replace(/\.json$/, '');
  for (const finding of scanFindings(report)) {
    if (finding.severity === 'CRITICAL') {
      criticalCount += 1;
      if (!coveredCritical.has(finding.cve)) {
        block(`CRITICAL ${finding.cve} has no OpenVEX statement`);
      }
    } else {
      highCount += 1;
    }
    const cover = coversFinding(decisions, imageName, finding);
    if (!cover) {
      if (finding.severity === 'CRITICAL') {
        block(`CRITICAL ${finding.cve} in ${imageName} is unclassified`);
      } else if (finding.fixedVersion) {
        applicableHigh += 1;
        block(`HIGH ${finding.cve} in ${imageName} is applicable, fixable, and not accepted`);
      } else {
        block(`HIGH ${finding.cve} in ${imageName} is unclassified`);
      }
      continue;
    }
    if (
      finding.severity === 'CRITICAL' &&
      cover.statement.status === 'ACCEPTED_TEMPORARILY' &&
      !waiverApproved(cover.statement)
    ) {
      addReason('CRITICAL_WAIVER_UNAPPROVED', {
        cve: finding.cve,
        image: imageName,
      });
    }
    if (cover.statement.status === 'AFFECTED_BLOCKING') {
      block(`${finding.severity} ${finding.cve} in ${imageName} is AFFECTED_BLOCKING`);
    }
    if (cover.statement.status === 'FIXED') {
      block(`${finding.cve} is marked fixed while the scanner still reports it`);
    }
  }
}

const releaseRecordPath = resolve(root, 'artifacts/release/record.json');
if (!existsSync(releaseRecordPath)) {
  partial('signed release record is absent');
  addReason('RELEASE_RECORD_ABSENT');
  addReason('SIGNATURES_NOT_VERIFIED');
  addReason('RELEASE_VEX_NOT_BOUND');
}

const result =
  blockers.length > 0 ? 'BLOCKED' : partials.length > 0 || reasons.length > 0 ? 'PARTIAL' : 'PASS';
mkdirSync(artifactDir, { recursive: true });
const summary = {
  status: result,
  result,
  reasons,
  blockers,
  partials,
  criticalFindings: criticalCount,
  highFindings: highCount,
  applicableFixableHigh: applicableHigh,
  multiArchRequired: false,
  productionDeployment: 'NOT_STARTED',
};
writeFileSync(resolve(artifactDir, 'gate.json'), `${JSON.stringify(summary, null, 2)}\n`);
const text = [
  `SUPPLY_CHAIN_GATE: ${result}`,
  ...blockers.map((item) => `BLOCK: ${item}`),
  ...partials.map((item) => `PARTIAL: ${item}`),
  ...reasons.map((item) => `REASON: ${item.code}`),
].join('\n');
writeFileSync(resolve(artifactDir, 'gate.txt'), `${text}\n`);
const mode = process.argv.includes('--mode=publish') ? 'publish' : 'audit';
if (mode === 'audit' && result !== 'PASS') {
  console.error('PUBLICATION_FORBIDDEN');
}
console.log(text);
process.exit(releaseGateExitCode(result, mode));
