#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const envPath = resolve(root, '.env');
const examplePath = resolve(root, '.env.example');
const destDir = resolve(root, 'infra/docker/secrets');

function parseEnv(text) {
  const values = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }
    const eq = line.indexOf('=');
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

const source = existsSync(envPath) ? envPath : examplePath;
const values = parseEnv(readFileSync(source, 'utf8'));
const api = values.REDIS_API_PASSWORD || values.REDIS_PASSWORD;
const worker = values.REDIS_WORKER_PASSWORD || values.REDIS_PASSWORD;
if (!api || !worker) {
  console.error('REDIS_API_PASSWORD or REDIS_PASSWORD is required to write local Redis secrets');
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
writeFileSync(resolve(destDir, 'redis_api_password'), api, { mode: 0o600 });
writeFileSync(resolve(destDir, 'redis_worker_password'), worker, { mode: 0o600 });
console.log('Wrote gitignored local Redis secret files');
