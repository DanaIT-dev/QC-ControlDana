import { describe, expect, it, vi } from 'vitest';
import {
  assessProductionReadiness,
  loadConfig,
  MissingConfigurationError,
  redisTlsOptions,
  resetStorageAliasWarnings,
} from '@sgr-registry/config';
import { sessionCookieOptions, sessionCookieSecure } from '../../src/auth/cookie';

function productionEnv(overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://sgr_app_user:sgr-app-production-secret@postgres:5432/sgr_registry',
    AUTH_DATABASE_URL:
      'postgresql://sgr_auth_user:sgr-auth-production-secret@postgres:5432/sgr_registry',
    WORKER_DATABASE_URL:
      'postgresql://sgr_worker_user:sgr-worker-production-secret@postgres:5432/sgr_registry',
    MIGRATION_DATABASE_URL:
      'postgresql://sgr_migrator:sgr-migrator-production-secret@postgres:5432/sgr_registry',
    RLS_CONTEXT_SECRET: 'production-rls-context-secret-value-32',
    REDIS_URL: 'redis://sgr_api:prod-redis-api-not-dev@redis:6379/0',
    WORKER_REDIS_URL: 'redis://sgr_worker:prod-redis-worker-not-dev@redis:6379/0',
    S3_ENDPOINT: 'https://object-storage.example.local',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'sgr-object-storage-production-access',
    S3_SECRET_ACCESS_KEY: 'sgr-object-storage-production-secret',
    S3_BUCKET: 'sgr-attachments',
    WEB_ORIGIN: 'https://sgr.example.local',
    PUBLIC_APP_URL: 'https://sgr.example.local',
    SMTP_HOST: 'smtp.example.internal',
    SMTP_PASSWORD: 'smtp-production-secret-value',
    EMAIL_FROM: 'sgr-registry@example.internal',
    ...overrides,
  };
}

describe('production session cookie policy', () => {
  it('forces Secure cookies only in production', () => {
    expect(sessionCookieSecure('production')).toBe(true);
    expect(sessionCookieSecure('development')).toBe(false);
    expect(sessionCookieSecure('test')).toBe(false);
    expect(sessionCookieOptions({ secure: true, maxAgeSeconds: 604800 })).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 604800,
    });
  });

  it('refuses production startup with HTTP origins or weakened lifetimes', () => {
    expect(() => loadConfig(productionEnv({ WEB_ORIGIN: 'http://localhost:3000' }))).toThrow(
      MissingConfigurationError,
    );
    expect(() =>
      loadConfig(productionEnv({ SESSION_IDLE_TIMEOUT_SECONDS: String(13 * 60 * 60) })),
    ).toThrow(MissingConfigurationError);
    expect(() =>
      loadConfig(productionEnv({ SESSION_ABSOLUTE_LIFETIME_SECONDS: String(8 * 24 * 60 * 60) })),
    ).toThrow(MissingConfigurationError);
    const config = loadConfig(productionEnv());
    expect(config.SESSION_IDLE_TIMEOUT_SECONDS).toBe(12 * 60 * 60);
    expect(config.SESSION_ABSOLUTE_LIFETIME_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(sessionCookieSecure(config.NODE_ENV)).toBe(true);
  });

  it('refuses production runtime URLs that use bootstrap, owner, or migrator roles', () => {
    expect(() =>
      loadConfig(productionEnv({ DATABASE_URL: 'postgresql://sgr_registry:x@localhost:5432/sgr' })),
    ).toThrow(MissingConfigurationError);
    expect(() =>
      loadConfig(productionEnv({ DATABASE_URL: 'postgresql://sgr_owner:x@localhost:5432/sgr' })),
    ).toThrow(MissingConfigurationError);
    expect(() =>
      loadConfig(
        productionEnv({ WORKER_DATABASE_URL: 'postgresql://sgr_migrator:x@localhost:5432/sgr' }),
      ),
    ).toThrow(MissingConfigurationError);
    expect(() =>
      loadConfig(
        productionEnv({ MIGRATION_DATABASE_URL: 'postgresql://sgr_registry:x@localhost:5432/sgr' }),
      ),
    ).toThrow(MissingConfigurationError);
  });

  it('refuses production Redis without ACL credentials or with the development password', () => {
    expect(() => loadConfig(productionEnv({ REDIS_URL: 'redis://127.0.0.1:6379' }))).toThrow(
      MissingConfigurationError,
    );
    expect(() =>
      loadConfig(
        productionEnv({
          REDIS_URL: 'redis://sgr_api:local-development-only@127.0.0.1:6379/0',
        }),
      ),
    ).toThrow(MissingConfigurationError);
    expect(() =>
      loadConfig(
        productionEnv({
          REDIS_URL: 'redis://sgr_worker:prod-redis-worker-not-dev@127.0.0.1:6379/0',
        }),
      ),
    ).toThrow(MissingConfigurationError);
    try {
      loadConfig(productionEnv({ REDIS_URL: 'redis://127.0.0.1:6379' }));
      throw new Error('expected MissingConfigurationError');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingConfigurationError);
      const message = error instanceof Error ? error.message : '';
      expect(message).toContain('REDIS_URL');
      expect(message).not.toMatch(/prod-redis|local-development-only|password=/i);
    }
    const config = loadConfig(productionEnv());
    expect(config.REDIS_URL).toContain('sgr_api');
    expect(config.WORKER_REDIS_URL).toContain('sgr_worker');
  });

  it('refuses mixing runtime database roles and public Redis without TLS', () => {
    expect(() =>
      loadConfig(
        productionEnv({ DATABASE_URL: 'postgresql://sgr_auth_user:sgr@localhost:5432/sgr' }),
      ),
    ).toThrow(MissingConfigurationError);
    expect(() =>
      loadConfig(
        productionEnv({ AUTH_DATABASE_URL: 'postgresql://sgr_app_user:sgr@localhost:5432/sgr' }),
      ),
    ).toThrow(MissingConfigurationError);
    expect(() =>
      loadConfig(
        productionEnv({
          WORKER_DATABASE_URL: 'postgresql://sgr_owner:sgr@localhost:5432/sgr',
        }),
      ),
    ).toThrow(MissingConfigurationError);
    expect(() =>
      loadConfig(
        productionEnv({
          REDIS_URL: 'redis://sgr_api:prod-redis-api-not-dev@redis.cloud.example:6379/0',
        }),
      ),
    ).toThrow(MissingConfigurationError);
    const tls = loadConfig(
      productionEnv({
        REDIS_URL: 'rediss://sgr_api:prod-redis-api-not-dev@redis.cloud.example:6379/0',
      }),
    );
    expect(tls.REDIS_URL.startsWith('rediss://')).toBe(true);
    expect(redisTlsOptions(tls.REDIS_URL)).toEqual({ tls: { rejectUnauthorized: true } });
    expect(redisTlsOptions('redis://sgr_api:x@127.0.0.1:6379/0')).toEqual({});
  });

  it('refuses production startup when secrets are missing, short, or taken from development', () => {
    const weak = 'sgr_minio_dev_password';
    expect(() => loadConfig(productionEnv({ S3_SECRET_ACCESS_KEY: weak }))).toThrow(
      MissingConfigurationError,
    );
    expect(() =>
      loadConfig(
        productionEnv({ RLS_CONTEXT_SECRET: 'local-dev-rls-hmac-secret-not-for-production' }),
      ),
    ).toThrow(MissingConfigurationError);
    expect(() => loadConfig(productionEnv({ SMTP_HOST: '127.0.0.1' }))).toThrow(
      MissingConfigurationError,
    );
    expect(() =>
      loadConfig(
        productionEnv({
          DATABASE_URL: 'postgresql://sgr_app_user:sgr_app_dev_password@postgres:5432/sgr_registry',
        }),
      ),
    ).toThrow(MissingConfigurationError);
    try {
      loadConfig(productionEnv({ S3_SECRET_ACCESS_KEY: weak, SMTP_PASSWORD: 'short' }));
      throw new Error('expected MissingConfigurationError');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingConfigurationError);
      const message = error instanceof Error ? error.message : '';
      expect(message).toContain('S3_SECRET_ACCESS_KEY');
      expect(message).not.toContain(weak);
      expect(message).not.toContain('short');
    }
  });
});

describe('object storage credential aliases', () => {
  it('rejects conflicting credential sets and production aliases without printing secrets', () => {
    resetStorageAliasWarnings();
    const canonical = 'canonical-access-key-value';
    const legacy = 'legacy-access-key-value';
    expect(() =>
      loadConfig(
        productionEnv({
          NODE_ENV: 'development',
          S3_ACCESS_KEY_ID: canonical,
          S3_ACCESS_KEY: legacy,
        }),
      ),
    ).toThrow(/S3_ACCESS_KEY_ID and S3_ACCESS_KEY differ/);
    try {
      loadConfig(productionEnv({ S3_ACCESS_KEY: legacy }));
      throw new Error('expected MissingConfigurationError');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingConfigurationError);
      const message = error instanceof Error ? error.message : '';
      expect(message).toContain('2026-12-31');
      expect(message).not.toContain(legacy);
    }
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    try {
      const config = loadConfig(
        productionEnv({
          NODE_ENV: 'development',
          S3_ACCESS_KEY_ID: undefined,
          S3_SECRET_ACCESS_KEY: undefined,
          S3_ACCESS_KEY: canonical,
          S3_SECRET_KEY: 'legacy-secret-key-value',
        }),
      );
      expect(config.S3_ACCESS_KEY_ID).toBe(canonical);
      expect(warnings.join('\n')).toContain('S3_ACCESS_KEY is deprecated');
      expect(warnings.join('\n')).toContain('2026-12-31');
      expect(warnings.join('\n')).not.toContain(canonical);
      expect(warnings.join('\n')).not.toContain('legacy-secret-key-value');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('production image references', () => {
  const digest = `sha256:${'ab'.repeat(32)}`;
  const sha = 'a'.repeat(40);

  it('rejects latest and non-digest image references without echoing them', () => {
    const failures = assessProductionReadiness({
      ...productionEnv(),
      SGR_IMAGE_TAG: 'latest',
      SGR_RUNTIME_IMAGE_DIGEST: 'latest',
      SGR_WEB_IMAGE_DIGEST: 'sha256:abc',
      SGR_MIGRATOR_IMAGE_DIGEST: '7-alpine',
    });
    expect(failures.map((failure) => failure.key)).toEqual(
      expect.arrayContaining([
        'SGR_IMAGE_TAG',
        'SGR_RUNTIME_IMAGE_DIGEST',
        'SGR_WEB_IMAGE_DIGEST',
        'SGR_MIGRATOR_IMAGE_DIGEST',
      ]),
    );
    expect(failures.map((failure) => failure.message).join('\n')).not.toContain('latest');
    expect(failures.map((failure) => failure.message).join('\n')).not.toContain('7-alpine');
  });

  it('rejects a platform outside the production set without echoing it', () => {
    const failures = assessProductionReadiness({
      ...productionEnv(),
      SGR_IMAGE_TAG: sha,
      SGR_RUNTIME_IMAGE_DIGEST: digest,
      SGR_WEB_IMAGE_DIGEST: digest,
      SGR_MIGRATOR_IMAGE_DIGEST: digest,
      SGR_PLATFORM: 'linux/386',
    });
    expect(failures.some((failure) => failure.key === 'SGR_PLATFORM')).toBe(true);
    expect(failures.map((failure) => failure.message).join('\n')).not.toContain('386');
  });

  it('accepts a Git SHA and immutable digests', () => {
    const failures = assessProductionReadiness({
      ...productionEnv(),
      SGR_IMAGE_TAG: sha,
      SGR_RUNTIME_IMAGE_DIGEST: digest,
      SGR_WEB_IMAGE_DIGEST: digest,
      SGR_MIGRATOR_IMAGE_DIGEST: digest,
      SGR_PLATFORM: 'linux/amd64',
    }).filter((failure) => failure.key.startsWith('SGR_'));
    expect(failures).toEqual([]);
  });
});
