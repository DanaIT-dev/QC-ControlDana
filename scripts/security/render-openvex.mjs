import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateOpenVex } from './openvex-lib.mjs';
import {
  coversFinding,
  imageDigest,
  repositoryFor,
  scanFindings,
  vexStatement,
} from './supply-chain.mjs';

const root = resolve(import.meta.dirname, '../..');
const pins = JSON.parse(readFileSync(resolve(root, 'infra/docker/image-pins.json'), 'utf8'));
const decisions = JSON.parse(
  readFileSync(resolve(root, 'docs/security/vulnerability-decisions.json'), 'utf8'),
);

const statements = [];
for (const decision of decisions.statements) {
  for (const imageName of decision.images) {
    const digest = imageDigest(pins, imageName);
    if (!digest) {
      continue;
    }
    statements.push(
      vexStatement(
        pins,
        decisions,
        imageName,
        { cve: decision.cve, digest },
        {
          statement: decision,
        },
      ),
    );
  }
}

const seen = new Set(
  statements.map((statement) => `${statement.vulnerability.name}|${statement.products[0]['@id']}`),
);
const trivyDir = resolve(root, 'artifacts/supply-chain/trivy');
if (existsSync(trivyDir)) {
  for (const fileName of readdirSync(trivyDir).filter((name) => name.endsWith('.json'))) {
    const imageName = fileName.replace(/\.json$/, '');
    const report = JSON.parse(readFileSync(resolve(trivyDir, fileName), 'utf8'));
    for (const finding of scanFindings(report)) {
      const cover = coversFinding(decisions, imageName, finding);
      if (!cover || cover.kind !== 'rule') {
        continue;
      }
      const digest = imageDigest(pins, imageName);
      if (!digest) {
        continue;
      }
      const statement = vexStatement(pins, decisions, imageName, { ...finding, digest }, cover);
      const key = `${statement.vulnerability.name}|${statement.products[0]['@id']}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      statements.push(statement);
    }
  }
}

const document = {
  '@context': 'https://openvex.dev/ns/v0.2.0',
  '@id': 'https://github.com/DanaIT-dev/QC-ControlDana/security/openvex.json',
  author: decisions.author,
  role: decisions.role,
  timestamp: decisions.reviewedAt,
  version: 1,
  statements,
};

const errors = validateOpenVex(document);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}

const destination = resolve(root, 'docs/security/openvex.json');
writeFileSync(destination, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `wrote ${statements.length} OpenVEX statements for ${new Set(statements.flatMap((statement) => statement.products.map((product) => product['@id']))).size} products`,
);
void repositoryFor;
