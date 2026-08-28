import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPOSE_PATH = resolve(import.meta.dirname, '../../../../infra/docker/compose.yaml');

function publishedPortMappings(yaml: string): string[] {
  const mappings: string[] = [];
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
      mappings.push(item[1]!.replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (/^\s+\S/.test(line)) {
      inPorts = false;
    }
  }
  return mappings;
}

describe('infrastructure compose published ports', () => {
  it('binds database, cache, storage and admin ports to loopback only', () => {
    const yaml = readFileSync(COMPOSE_PATH, 'utf8');
    const mappings = publishedPortMappings(yaml);
    expect(mappings.length).toBeGreaterThan(0);
    for (const mapping of mappings) {
      expect(mapping, `unbound mapping: ${mapping}`).toMatch(/^127\.0\.0\.1:/);
      expect(mapping).not.toMatch(/0\.0\.0\.0/);
      expect(mapping).not.toMatch(/\[::]/);
    }
    expect(yaml).toMatch(/127\.0\.0\.1:\$\{POSTGRES_PORT:-5432}:5432/);
    expect(yaml).toMatch(/127\.0\.0\.1:\$\{REDIS_PORT:-6379}:6379/);
    expect(yaml).toMatch(/127\.0\.0\.1:\$\{MINIO_API_PORT:-9000}:9000/);
    expect(yaml).toMatch(/127\.0\.0\.1:\$\{MINIO_CONSOLE_PORT:-9001}:9001/);
    expect(yaml).toMatch(/127\.0\.0\.1:\$\{CLAMD_PORT:-3310}:3310/);
    expect(yaml).toMatch(/127\.0\.0\.1:\$\{MAILPIT_SMTP_PORT:-1025}:1025/);
    expect(yaml).toMatch(/127\.0\.0\.1:\$\{MAILPIT_UI_PORT:-8025}:8025/);
  });
});
