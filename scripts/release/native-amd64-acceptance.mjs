#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const arch = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
const recordPath = resolve(root, 'artifacts/release/record.json');

if (arch !== 'x86_64') {
  console.log(JSON.stringify({ result: 'NOT_NATIVE', uname: arch, qemu: 'not used as evidence' }));
  process.exit(1);
}

if (!existsSync(recordPath)) {
  console.log(
    JSON.stringify({
      result: 'NOT_RUN',
      uname: arch,
      reason: 'Published release record is absent. This job is not a persistent staging server.',
    }),
  );
  process.exit(1);
}

const record = JSON.parse(readFileSync(recordPath, 'utf8'));
const images = Array.isArray(record.images) ? record.images : [];
const missing = images.filter((image) => !image.registryDigest || image.platform !== 'linux/amd64');
if (missing.length > 0 || !record.minioAmd64Digest) {
  console.log(
    JSON.stringify({
      result: 'NOT_RUN',
      uname: arch,
      reason:
        'Immutable linux/amd64 digests are incomplete, so ephemeral acceptance was not started.',
    }),
  );
  process.exit(1);
}

console.log(
  JSON.stringify({
    result: 'NOT_EXECUTED',
    uname: arch,
    imageCount: images.length,
    persistentStaging: false,
  }),
);
process.exit(1);
