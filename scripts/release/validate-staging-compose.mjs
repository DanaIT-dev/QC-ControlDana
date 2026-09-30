#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const composePath = resolve(root, 'infra/docker/compose.staging.yaml');

export function validateStagingCompose(yaml) {
  const errors = [];
  if (/^\s*build:/m.test(yaml)) {
    errors.push('staging compose must not build from source');
  }
  if (/:latest\b/.test(yaml)) {
    errors.push('staging compose must not use a latest tag');
  }
  if (yaml.includes('${SGR_PLATFORM')) {
    errors.push('staging platform must be the literal linux/amd64');
  }
  if (!yaml.includes('platform: linux/amd64')) {
    errors.push('staging compose must set platform linux/amd64');
  }
  const sourceMount = yaml
    .split('\n')
    .filter((line) => /^\s+-\s+\.\.?\//.test(line))
    .filter(
      (line) =>
        !line.includes('./Caddyfile.staging') &&
        !line.includes('./redis/acl-entrypoint.sh') &&
        !line.includes('./secrets/'),
    );
  if (sourceMount.length > 0) {
    errors.push('staging compose must not mount application source');
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
  const lines = yaml.split('\n');
  function serviceBlock(name) {
    const start = lines.findIndex((line) => line === `  ${name}:`);
    if (start < 0) {
      return '';
    }
    const chunk = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(line) || /^(secrets|networks|volumes):/.test(line)) {
        break;
      }
      chunk.push(line);
    }
    return chunk.join('\n');
  }
  for (const name of privateServices) {
    const block = serviceBlock(name);
    if (!block) {
      errors.push(`staging compose is missing ${name}`);
      continue;
    }
    if (/^\s+ports:\s*$/m.test(block)) {
      errors.push(`${name} must not publish ports`);
    }
    if (!block.includes('*hardening') && !block.includes('platform: linux/amd64')) {
      errors.push(`${name} must select linux/amd64`);
    }
  }
  const proxy = serviceBlock('proxy');
  if (!proxy.includes('80:80')) {
    errors.push('only the reverse proxy may publish a staging port');
  }
  if (proxy.includes('443:443') && !proxy.includes('Caddyfile.staging')) {
    errors.push('staging HTTPS requires the staging Caddyfile');
  }
  if (!yaml.includes('Caddyfile.staging')) {
    errors.push('staging proxy must use the isolated staging Caddyfile');
  }
  if (yaml.includes('mailpit') || yaml.includes('db:seed') || yaml.includes('migrate reset')) {
    errors.push('staging compose must not seed or reset the database');
  }
  const imageLines = lines.filter((line) => /^\s+image:/.test(line));
  for (const line of imageLines) {
    if (!/@sha256:[a-f0-9]{64}/.test(line) && !/@\$\{SGR_[A-Z0-9_]+IMAGE_DIGEST:/.test(line)) {
      errors.push(`staging image is not immutable: ${line.trim()}`);
    }
  }
  if (!yaml.includes('sgr_staging_postgres')) {
    errors.push('staging must use a separate postgres volume');
  }
  if (yaml.includes('production.') || yaml.includes('SGR_TLS_DOMAIN')) {
    errors.push('staging compose must not target production DNS or TLS settings');
  }
  return errors;
}

function main() {
  const yaml = readFileSync(composePath, 'utf8');
  const errors = validateStagingCompose(yaml);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log('staging compose is digest-pinned, amd64-only, and isolated from production');
}

if (process.argv[1] && process.argv[1].endsWith('validate-staging-compose.mjs')) {
  main();
}
