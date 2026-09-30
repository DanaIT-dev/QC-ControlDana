import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const config = new URL('../../.gitleaks.toml', import.meta.url);
const image =
  'zricethezav/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854';

function scan(dir) {
  const report = join(dir, 'report.json');
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      'linux/arm64',
      '-v',
      `${dir}:/repo`,
      '-v',
      `${config.pathname}:/config.toml:ro`,
      image,
      'detect',
      '--no-git',
      '--source',
      '/repo',
      '--redact',
      '--no-banner',
      '--config',
      '/config.toml',
      '--report-format',
      'json',
      '--report-path',
      '/repo/report.json',
    ],
    { encoding: 'utf8' },
  );
  if (result.stderr?.includes('Failed to load config')) {
    throw new Error(result.stderr);
  }
  const raw = spawnSync('cat', [report], { encoding: 'utf8' }).stdout || '[]';
  const findings = JSON.parse(raw);
  return Array.isArray(findings) ? findings : [];
}

function githubPat(body) {
  return ['ghp', '_', body].join('');
}

function privateKey() {
  return [
    '-----BEGIN ',
    'RSA PRIVATE KEY-----\n',
    'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF4P8s+n0g5xQ\n',
    '-----END ',
    'RSA PRIVATE KEY-----\n',
  ].join('');
}
function hasFile(findings, name) {
  return findings.some((item) => String(item.File ?? '').endsWith(name));
}

test('a checksum-only SBOM index is not a secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-checksum-'));
  const docs = join(dir, 'docs/security');
  mkdirSync(docs, { recursive: true });
  writeFileSync(
    join(docs, 'sbom-index.json'),
    `${JSON.stringify({ checksums: { 'api.cdx.json': 'ab'.repeat(32) } }, null, 2)}\n`,
  );
  assert.equal(hasFile(scan(dir), 'sbom-index.json'), false);
});

test('a token, another JSON field, and a private key are still detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-secrets-'));
  const docs = join(dir, 'docs/security');
  mkdirSync(docs, { recursive: true });
  writeFileSync(
    join(docs, 'sbom-index.json'),
    `${JSON.stringify(
      {
        checksums: { 'api.cdx.json': 'ab'.repeat(32) },
        apiKey: githubPat('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(docs, 'other.json'),
    `${JSON.stringify({ token: githubPat('B1c2D3e4F5g6H7i8J9k0L1m2N3o4P5q6R7s8') }, null, 2)}\n`,
  );
  writeFileSync(join(docs, 'key.pem'), privateKey());
  const findings = scan(dir);
  assert.equal(hasFile(findings, 'sbom-index.json'), true);
  assert.equal(hasFile(findings, 'other.json'), true);
  assert.equal(hasFile(findings, 'key.pem'), true);
});
