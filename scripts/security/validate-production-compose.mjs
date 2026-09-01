#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const composePath = resolve(root, 'infra/docker/compose.production.yaml');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function serviceBlock(yaml, name) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) {
    return '';
  }
  const chunk = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(line) || /^(secrets|networks|volumes):/.test(line)) {
      break;
    }
    chunk.push(line);
  }
  return chunk.join('\n');
}

const yaml = readFileSync(composePath, 'utf8');
const redis = serviceBlock(yaml, 'redis');
if (!redis) {
  fail('production compose is missing the redis service');
}
if (/^\s+ports:\s*$/m.test(redis)) {
  fail('REDIS production compose must not publish ports');
}
if (redis.includes('0.0.0.0') || redis.includes('[::]')) {
  fail('REDIS production compose must not bind 0.0.0.0');
}
if (!redis.includes('protected-mode yes') && !yaml.includes('acl-entrypoint.sh')) {
  fail('REDIS production compose must enable protected-mode or the ACL entrypoint');
}
if (/\brequirepass\b/.test(yaml) || /--requirepass/.test(yaml)) {
  fail('REDIS production compose must not pass requirepass on the command line');
}
if (/REDIS_PASSWORD\s*:/.test(redis) && !/REDIS_.*PASSWORD_FILE/.test(redis)) {
  fail('REDIS production compose must not inline Redis passwords');
}
if (yaml.includes('local-development-only')) {
  fail('production compose must not use the development Redis password');
}

console.log('production Redis compose does not publish ports and does not inline credentials');
