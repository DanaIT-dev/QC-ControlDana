#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = resolve(root, 'artifacts/release');

const VERSION = 'RELEASE.2025-04-22T22-12-26Z';
const ACCEPT =
  'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json';

async function request(url, headers = {}) {
  const response = await fetch(url, { headers });
  const body = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

async function probeRegistry(name, tokenUrl, manifestUrl) {
  const tokenResponse = await request(tokenUrl);
  let token = '';
  try {
    const payload = JSON.parse(tokenResponse.body);
    token = payload.token || payload.access_token || '';
  } catch {
    token = '';
  }
  const manifest = await request(manifestUrl, {
    Authorization: token ? `Bearer ${token}` : '',
    Accept: ACCEPT,
  });
  let error = null;
  try {
    const payload = JSON.parse(manifest.body);
    error = payload.errors?.[0]?.code ?? payload.errors?.[0]?.message ?? null;
  } catch {
    error = manifest.status === 200 ? null : 'unparsed-body';
  }
  const authenticate = manifest.headers['www-authenticate'] ?? '';
  if (authenticate.includes('insufficient_scope')) {
    error = 'insufficient_scope';
  }
  return {
    repository: name,
    httpStatus: manifest.status,
    error,
    manifestListDigest: manifest.headers['docker-content-digest'] ?? null,
    amd64Digest: null,
    authenticated: false,
  };
}

const checkedAt = new Date().toISOString();
mkdirSync(outputDir, { recursive: true });
const probes = [];
probes.push(
  await probeRegistry(
    'docker.io/minio/minio',
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:minio/minio:pull`,
    `https://registry-1.docker.io/v2/minio/minio/manifests/${VERSION}`,
  ),
);
probes.push(
  await probeRegistry(
    'quay.io/minio/minio',
    `https://quay.io/v2/auth?service=quay.io&scope=repository:minio/minio:pull`,
    `https://quay.io/v2/minio/minio/manifests/${VERSION}`,
  ),
);

const confirmed = probes.find((probe) => probe.amd64Digest);
const report = {
  checkedAt,
  version: VERSION,
  upstreamRepository: 'https://github.com/minio/minio',
  upstreamRelease: `https://github.com/minio/minio/releases/tag/${VERSION}`,
  localArm64ImageIdUsed: false,
  amd64Confirmed: Boolean(confirmed),
  manifestListDigest: confirmed?.manifestListDigest ?? null,
  linuxAmd64Digest: confirmed?.amd64Digest ?? null,
  probes,
};

writeFileSync(resolve(outputDir, 'minio-probe.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ amd64Confirmed: report.amd64Confirmed, probes: report.probes }));
process.exit(report.amd64Confirmed ? 0 : 2);
