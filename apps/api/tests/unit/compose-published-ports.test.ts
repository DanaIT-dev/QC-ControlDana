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
    expect(yaml).toMatch(/REDIS_API_PASSWORD_FILE/);
    expect(yaml).not.toMatch(/REDIS_PASSWORD:\s*\$\{/);
    expect(yaml).not.toMatch(/REDISCLI_AUTH:\s*\$\{/);
    expect(yaml).toMatch(/127\.0\.0\.1:\$\{MINIO_API_PORT:-9000}:9000/);
    expect(yaml).toMatch(/127\.0\.0\.1:\$\{MINIO_CONSOLE_PORT:-9001}:9001/);
    expect(yaml).toMatch(/127\.0\.0\.1:\$\{CLAMD_PORT:-3310}:3310/);
    expect(yaml).toMatch(/127\.0\.0\.1:\$\{MAILPIT_SMTP_PORT:-1025}:1025/);
    expect(yaml).toMatch(/127\.0\.0\.1:\$\{MAILPIT_UI_PORT:-8025}:8025/);
  });

  it('publishes only the reverse proxy and keeps Redis private', () => {
    const productionPath = resolve(
      import.meta.dirname,
      '../../../../infra/docker/compose.production.yaml',
    );
    const yaml = readFileSync(productionPath, 'utf8');
    const redis = yaml.slice(yaml.indexOf('\n  redis:'), yaml.indexOf('\n  minio:'));
    const proxy = yaml.slice(yaml.indexOf('\n  proxy:'), yaml.indexOf('\n  web:'));
    expect(yaml).toMatch(/^\s+redis:/m);
    expect(redis).not.toMatch(/^\s+ports:\s*$/m);
    expect(publishedPortMappings(yaml)).toEqual(['80:80', '443:443']);
    expect(proxy).toMatch(/443:443/);
    expect(yaml).not.toMatch(/0\.0\.0\.0/);
    expect(yaml).not.toMatch(/local-development-only/);
    expect(yaml).not.toMatch(/requirepass/);
    expect(yaml).toMatch(/acl-entrypoint\.sh/);
    const acl = readFileSync(
      resolve(import.meta.dirname, '../../../../infra/docker/redis/acl-entrypoint.sh'),
      'utf8',
    );
    expect(acl).toMatch(/~sgr-e2e:\*/);
    expect(acl).toMatch(/~sgr-test:\*/);
    expect(acl).toMatch(/-FLUSHALL/);
  });
});
