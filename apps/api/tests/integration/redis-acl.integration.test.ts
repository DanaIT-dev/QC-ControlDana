import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, redisTlsOptions } from '@sgr-registry/config';
import Redis from 'ioredis';

function hostPortOf(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379) };
}

function withUserPassword(url: string, username: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
}

async function expectRejected(action: () => Promise<unknown>, secret: string): Promise<void> {
  try {
    await action();
    throw new Error('expected Redis command to be rejected');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toBe('expected Redis command to be rejected');
    expect(message.includes(secret)).toBe(false);
  }
}

describe('Redis ACL', () => {
  const clients: Redis[] = [];

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.quit().catch(() => undefined)));
  });

  it('rejects connections without credentials and with the wrong password', async () => {
    const config = loadConfig();
    const { host, port } = hostPortOf(config.REDIS_URL);
    const password = decodeURIComponent(new URL(config.REDIS_URL).password);
    const noAuth = new Redis({
      host,
      port,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    clients.push(noAuth);
    await expectRejected(() => noAuth.connect().then(() => noAuth.ping()), password);

    const wrong = new Redis(
      withUserPassword(config.REDIS_URL, 'sgr_api', 'wrong-password-not-used'),
      {
        ...redisTlsOptions(config.REDIS_URL),
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        lazyConnect: true,
        enableOfflineQueue: false,
      },
    );
    clients.push(wrong);
    await expectRejected(() => wrong.connect().then(() => wrong.ping()), password);
  });

  it('accepts sgr_api and sgr_worker and rejects administrative commands', async () => {
    const config = loadConfig();
    const password = decodeURIComponent(new URL(config.REDIS_URL).password);
    const api = new Redis(config.REDIS_URL, {
      ...redisTlsOptions(config.REDIS_URL),
      maxRetriesPerRequest: 1,
    });
    const worker = new Redis(config.WORKER_REDIS_URL, {
      ...redisTlsOptions(config.WORKER_REDIS_URL),
      maxRetriesPerRequest: 1,
    });
    clients.push(api, worker);
    expect(await api.ping()).toBe('PONG');
    expect(await worker.ping()).toBe('PONG');
    const prefix = config.REDIS_KEY_PREFIX;
    await api.set(`${prefix}:acl-probe`, '1', 'EX', 30);
    expect(await api.get(`${prefix}:acl-probe`)).toBe('1');
    await expectRejected(() => api.config('SET', 'save', ''), password);
    await expectRejected(() => api.flushall(), password);
    await expectRejected(() => api.flushdb(), password);
    await expectRejected(() => api.call('SHUTDOWN') as Promise<unknown>, password);
    await expectRejected(() => api.call('DEBUG', 'HELP') as Promise<unknown>, password);
    await expectRejected(() => api.call('MODULE', 'LIST') as Promise<unknown>, password);
  });

  it('keeps Redis passwords out of container env and process arguments', () => {
    const inspect = JSON.parse(
      execFileSync('docker', ['inspect', 'sgr-registry-redis'], { encoding: 'utf8' }),
    )[0] as { Config: { Env: string[] }; Args: string[] };
    const values = [...inspect.Config.Env, ...inspect.Args];
    const leaked = values.some(
      (item) =>
        /^(REDIS_PASSWORD|REDIS_API_PASSWORD|REDIS_WORKER_PASSWORD|REDISCLI_AUTH)=/.test(item) ||
        item.includes('local-development-only') ||
        /requirepass/i.test(item),
    );
    expect(leaked).toBe(false);
    expect(inspect.Config.Env.some((item) => item.startsWith('REDIS_API_PASSWORD_FILE='))).toBe(
      true,
    );
  });
});
