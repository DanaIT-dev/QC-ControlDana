import { describe, expect, it } from 'vitest';
import {
  applyE2eEnv,
  assertE2eDatabaseTarget,
  E2E_DATABASE_NAME,
  E2E_REDIS_KEY_PREFIX,
  E2E_S3_BUCKET,
} from '../../src/e2e-target';

function validE2eEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    SGR_E2E_TARGET_CONFIRM: E2E_DATABASE_NAME,
    DATABASE_URL: 'postgresql://sgr_app_user:x@127.0.0.1:5432/sgr_registry_e2e',
    AUTH_DATABASE_URL: 'postgresql://sgr_auth_user:x@127.0.0.1:5432/sgr_registry_e2e',
    WORKER_DATABASE_URL: 'postgresql://sgr_worker_user:x@127.0.0.1:5432/sgr_registry_e2e',
    MIGRATION_DATABASE_URL: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry_e2e',
    REDIS_URL: 'redis://sgr_api:x@127.0.0.1:6379/14',
    WORKER_REDIS_URL: 'redis://sgr_worker:x@127.0.0.1:6379/14',
    REDIS_KEY_PREFIX: E2E_REDIS_KEY_PREFIX,
    S3_BUCKET: E2E_S3_BUCKET,
    ...overrides,
  };
}

describe('assertE2eDatabaseTarget', () => {
  it('rejects the development database before any write', () => {
    expect(() =>
      assertE2eDatabaseTarget(
        validE2eEnv({
          DATABASE_URL: 'postgresql://sgr_app_user:x@127.0.0.1:5432/sgr_registry',
          AUTH_DATABASE_URL: 'postgresql://sgr_auth_user:x@127.0.0.1:5432/sgr_registry',
          WORKER_DATABASE_URL: 'postgresql://sgr_worker_user:x@127.0.0.1:5432/sgr_registry',
          MIGRATION_DATABASE_URL: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry',
        }),
      ),
    ).toThrow(/sgr_registry/);
    expect(() =>
      assertE2eDatabaseTarget(
        validE2eEnv({
          DATABASE_URL: 'postgresql://sgr_app_user:x@127.0.0.1:5432/sgr_registry',
          AUTH_DATABASE_URL: 'postgresql://sgr_auth_user:x@127.0.0.1:5432/sgr_registry',
          WORKER_DATABASE_URL: 'postgresql://sgr_worker_user:x@127.0.0.1:5432/sgr_registry',
          MIGRATION_DATABASE_URL: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry',
        }),
      ),
    ).not.toThrow(/postgresql:\/\//);
  });

  it('rejects the integration test database when only the E2E database is allowed', () => {
    expect(() =>
      assertE2eDatabaseTarget(
        validE2eEnv({
          DATABASE_URL: 'postgresql://sgr_app_user:x@127.0.0.1:5432/sgr_registry_test',
          AUTH_DATABASE_URL: 'postgresql://sgr_auth_user:x@127.0.0.1:5432/sgr_registry_test',
          WORKER_DATABASE_URL: 'postgresql://sgr_worker_user:x@127.0.0.1:5432/sgr_registry_test',
          MIGRATION_DATABASE_URL: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry_test',
        }),
      ),
    ).toThrow(/sgr_registry_test/);
  });

  it('rejects a production URL', () => {
    expect(() => assertE2eDatabaseTarget(validE2eEnv({ NODE_ENV: 'production' }))).toThrow(
      /production/,
    );
    expect(() =>
      assertE2eDatabaseTarget(
        validE2eEnv({
          DATABASE_URL: 'postgresql://sgr_app_user:x@db.prod.example:5432/sgr_registry_e2e',
          AUTH_DATABASE_URL: 'postgresql://sgr_auth_user:x@db.prod.example:5432/sgr_registry_e2e',
          WORKER_DATABASE_URL:
            'postgresql://sgr_worker_user:x@db.prod.example:5432/sgr_registry_e2e',
          MIGRATION_DATABASE_URL:
            'postgresql://sgr_migrator:x@db.prod.example:5432/sgr_registry_e2e',
        }),
      ),
    ).toThrow(/db.prod.example/);
  });

  it('allows the dedicated E2E database with matching isolation', () => {
    expect(() => assertE2eDatabaseTarget(validE2eEnv())).not.toThrow();
  });

  it('rejects mismatched databases, runtime migrator credentials, and shared Redis/MinIO', () => {
    expect(() =>
      assertE2eDatabaseTarget(
        validE2eEnv({
          AUTH_DATABASE_URL: 'postgresql://sgr_auth_user:x@127.0.0.1:5432/sgr_registry',
        }),
      ),
    ).toThrow(/sgr_registry/);
    expect(() =>
      assertE2eDatabaseTarget(
        validE2eEnv({
          DATABASE_URL: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry_e2e',
        }),
      ),
    ).toThrow(/sgr_migrator/);
    expect(() =>
      assertE2eDatabaseTarget(validE2eEnv({ REDIS_URL: 'redis://sgr_api:x@127.0.0.1:6379/0' })),
    ).toThrow(/development namespace/);
    expect(() => assertE2eDatabaseTarget(validE2eEnv({ REDIS_KEY_PREFIX: 'sgr' }))).toThrow(
      /REDIS_KEY_PREFIX/,
    );
    expect(() => assertE2eDatabaseTarget(validE2eEnv({ S3_BUCKET: 'sgr-attachments' }))).toThrow(
      /S3_BUCKET/,
    );
  });

  it('remaps role URLs onto the E2E database name', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgresql://sgr_app_user:x@127.0.0.1:5432/sgr_registry',
      AUTH_DATABASE_URL: 'postgresql://sgr_auth_user:x@127.0.0.1:5432/sgr_registry',
      WORKER_DATABASE_URL: 'postgresql://sgr_worker_user:x@127.0.0.1:5432/sgr_registry',
      MIGRATION_DATABASE_URL: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry',
      REDIS_URL: 'redis://sgr_api:x@127.0.0.1:6379/0',
      WORKER_REDIS_URL: 'redis://sgr_worker:x@127.0.0.1:6379/0',
      REDIS_KEY_PREFIX: 'sgr',
      S3_BUCKET: 'sgr-attachments',
    };
    applyE2eEnv('postgresql://sgr_registry:x@127.0.0.1:5432/sgr_registry_e2e', env);
    expect(env.DATABASE_URL).toContain('/sgr_registry_e2e');
    expect(env.AUTH_DATABASE_URL).toContain('sgr_auth_user');
    expect(env.MIGRATION_DATABASE_URL).toContain('sgr_migrator');
    expect(env.REDIS_URL).toMatch(/\/14$/);
    expect(env.REDIS_KEY_PREFIX).toBe(E2E_REDIS_KEY_PREFIX);
    expect(env.S3_BUCKET).toBe(E2E_S3_BUCKET);
    expect(() => assertE2eDatabaseTarget(env)).not.toThrow();
  });
});
