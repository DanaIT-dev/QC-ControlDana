#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const composePath = resolve(root, 'infra/docker/compose.yaml');

function publishedPortMappings(yaml) {
  const mappings = [];
  let inPorts = false;
  for (const line of yaml.split('\n')) {
    if (/^\s+ports:\s*$/.test(line)) {
      inPorts = true;
      continue;
    }
    if (!inPorts) {
      continue;
    }
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (item) {
      mappings.push(item[1].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (/^\s+\S/.test(line)) {
      inPorts = false;
    }
  }
  return mappings;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const yaml = readFileSync(composePath, 'utf8');
const mappings = publishedPortMappings(yaml);
if (mappings.length === 0) {
  fail('compose.yaml has no published ports');
}
for (const mapping of mappings) {
  if (!mapping.startsWith('127.0.0.1:')) {
    fail(`compose publishes a non-loopback port: ${mapping}`);
  }
  if (mapping.includes('0.0.0.0') || mapping.includes('[::]')) {
    fail(`compose publishes on all interfaces: ${mapping}`);
  }
}

let inspectJson = '[]';
try {
  inspectJson = execFileSync(
    'docker',
    ['compose', '-f', composePath, '--env-file', resolve(root, '.env'), 'ps', '--format', 'json'],
    { encoding: 'utf8', cwd: root },
  );
} catch {
  fail('docker compose ps failed; start local infrastructure first');
}

const lines = inspectJson
  .trim()
  .split('\n')
  .filter(Boolean)
  .flatMap((line) => {
    const parsed = JSON.parse(line);
    return Array.isArray(parsed) ? parsed : [parsed];
  });

if (lines.length === 0) {
  fail('no compose services are running');
}

for (const service of lines) {
  const name = service.Name || service.ID;
  const ports = execFileSync('docker', ['port', name], { encoding: 'utf8' }).trim();
  if (!ports) {
    continue;
  }
  for (const row of ports.split('\n')) {
    if (!row.trim()) {
      continue;
    }
    if (row.includes('0.0.0.0') || row.includes('[::]')) {
      fail(`container ${name} publishes on all interfaces: ${row}`);
    }
    if (!/127\.0\.0\.1/.test(row) && !/\[::1\]/.test(row)) {
      fail(`container ${name} publishes off loopback: ${row}`);
    }
  }
}

const redisPort = Number.parseInt(process.env.REDIS_PORT || '6379', 10);
const extraIps = Object.values(networkInterfaces())
  .flat()
  .filter((item) => item && item.family === 'IPv4' && !item.internal)
  .map((item) => item.address);

await Promise.all(
  extraIps.map(
    (ip) =>
      new Promise((resolveCheck) => {
        const socket = createConnection({ host: ip, port: redisPort, timeout: 750 });
        socket.on('connect', () => {
          socket.destroy();
          fail(`Redis is reachable on non-loopback ${ip}:${redisPort}`);
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolveCheck();
        });
        socket.on('error', () => resolveCheck());
      }),
  ),
);

console.log('docker published ports are loopback-only');
