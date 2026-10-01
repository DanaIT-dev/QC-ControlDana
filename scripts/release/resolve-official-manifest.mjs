#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = resolve(root, 'artifacts/release');
const pins = JSON.parse(readFileSync(resolve(root, 'infra/docker/image-pins.json'), 'utf8'));
const image = pins.images['object-storage'];
const digest = image?.platforms?.['linux/amd64'] ?? null;
const report = {
  provider: image?.repository?.includes('seaweedfs') ? 'seaweedfs' : 'unknown',
  repository: image?.repository ?? null,
  version: image?.version ?? null,
  manifestList: image?.manifestList ?? null,
  linuxAmd64Digest: digest,
  linuxArm64Digest: image?.platforms?.['linux/arm64'] ?? null,
  amd64Confirmed: Boolean(image?.amd64Confirmed && digest),
  probedRegistries: [],
  note: 'Digest is taken from the pinned official manifest list. This script does not contact Docker Hub or Quay.',
};
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'object-storage.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ amd64Confirmed: report.amd64Confirmed, version: report.version }));
if (!report.amd64Confirmed) {
  process.exit(1);
}
