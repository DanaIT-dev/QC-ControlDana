import { describe, expect, it } from 'vitest';
import { loadConfig, MissingConfigurationError } from '@sgr-registry/config';
import { sessionCookieOptions, sessionCookieSecure } from '../../src/auth/cookie';

function productionEnv(overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://sgr:sgr@localhost:5432/sgr_registry',
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'https://minio.example.local',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'key',
    S3_SECRET_KEY: 'secret',
    S3_BUCKET: 'sgr-attachments',
    WEB_ORIGIN: 'https://sgr.example.local',
    PUBLIC_APP_URL: 'https://sgr.example.local',
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
});
