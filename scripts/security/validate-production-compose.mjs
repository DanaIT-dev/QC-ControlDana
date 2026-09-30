#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const composePath = resolve(root, 'infra/docker/compose.production.yaml');
const yaml = readFileSync(composePath, 'utf8');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function serviceBlock(name) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) {
    return '';
  }
  const chunk = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(line) || /^(secrets|networks|volumes):/.test(line)) {
      break;
    }
    chunk.push(line);
  }
  return chunk.join('\n');
}

const privateServices = [
  'postgres',
  'redis',
  'minio',
  'clamav',
  'api',
  'worker',
  'web',
  'migrator',
];
for (const name of privateServices) {
  const block = serviceBlock(name);
  if (!block) {
    fail(`production compose is missing the ${name} service`);
  }
  if (/^\s+ports:\s*$/m.test(block)) {
    fail(`${name} must not publish ports in production`);
  }
}

const proxy = serviceBlock('proxy');
if (!proxy) {
  fail('production compose is missing the reverse proxy');
}
if (!proxy.includes('"443:443"') && !proxy.includes('443:443')) {
  fail('the reverse proxy must publish HTTPS');
}
if (!yaml.includes('Caddyfile.production')) {
  fail('the reverse proxy must terminate TLS');
}
if (yaml.includes('mailpit') || yaml.includes('SEED_DEMO_PASSWORD') || yaml.includes('db:seed')) {
  fail('production compose must not include mailpit or seed');
}
if (yaml.includes('local-development-only') || yaml.includes('_dev_password')) {
  fail('production compose must not contain development credentials');
}
if (!yaml.includes('max-size:') || !yaml.includes('restart: unless-stopped')) {
  fail('production compose must set log rotation and a restart policy');
}
if (!yaml.includes('memory:') || !yaml.includes('stop_grace_period:')) {
  fail('production compose must set resource limits and a shutdown grace period');
}
if (!/profiles:\s*\[['"]migrate['"]\]/.test(yaml)) {
  fail('migrations must be a separate compose profile');
}
const redis = serviceBlock('redis');
if (!redis.includes('acl-entrypoint.sh')) {
  fail('REDIS production compose must use the ACL entrypoint');
}
if (/\brequirepass\b/.test(yaml) || /--requirepass/.test(yaml)) {
  fail('REDIS production compose must not pass requirepass on the command line');
}
if (/REDIS_PASSWORD\s*:/.test(redis) && !/REDIS_.*PASSWORD_FILE/.test(redis)) {
  fail('REDIS production compose must not inline Redis passwords');
}
if (yaml.includes('0.0.0.0:') || yaml.includes('[::]:')) {
  fail('production compose must not bind wildcard host addresses');
}
if (/:latest\b/.test(yaml)) {
  fail('production compose must not use a latest image tag');
}
const imageLines = yaml.split('\n').filter((line) => /^\s+image:/.test(line));
if (imageLines.length === 0) {
  fail('production compose has no images');
}
for (const line of imageLines) {
  if (!/@sha256:[a-f0-9]{64}/.test(line) && !/@\$\{SGR_[A-Z0-9_]*IMAGE_DIGEST:/.test(line)) {
    fail(`production image is not immutable: ${line.trim()}`);
  }
}
if (!yaml.includes('platform: ${SGR_PLATFORM:-linux/amd64}')) {
  fail('production compose must select linux/amd64 unless SGR_PLATFORM overrides it');
}
for (const name of ['api', 'web', 'worker', 'migrator']) {
  const block = serviceBlock(name);
  if (!block.includes('*app-fs')) {
    fail(`${name} must use the read-only non-root filesystem anchor`);
  }
}
const pins = JSON.parse(readFileSync(resolve(root, 'infra/docker/image-pins.json'), 'utf8'));
for (const image of Object.values(pins.images)) {
  if (!image.manifestList) {
    continue;
  }
  for (const digest of Object.values(image.platforms ?? {})) {
    if (digest && digest !== image.manifestList && yaml.includes(digest)) {
      fail('production compose must pin the multi-arch manifest digest, not a platform digest');
    }
  }
}
const minio = pins.images.minio;
if (minio?.platforms?.['linux/arm64'] && yaml.includes(minio.platforms['linux/arm64'])) {
  fail('production compose must not pin the arm64 MinIO digest for an amd64 deployment');
}

console.log('production compose publishes only the reverse proxy and keeps data services private');
