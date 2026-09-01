import { describe, expect, it } from 'vitest';
import { loginRequestSchema } from '@sgr-registry/contracts';
import { isLoginRateLimited } from '../../src/auth/redis-session.store';
import { isAllowedBrowserSource, isAllowedOrigin } from '../../src/auth/request-meta';
import { JSON_BODY_MAX_BYTES, isMultipartUploadRoute } from '../../src/common/http-limits';

describe('browser origin and referer', () => {
  const webOrigin = 'http://localhost:3000';

  it('rejects a missing Origin unless Referer matches WEB_ORIGIN', () => {
    expect(isAllowedOrigin(undefined, webOrigin)).toBe(false);
    expect(isAllowedBrowserSource(undefined, undefined, webOrigin)).toBe(false);
    expect(isAllowedBrowserSource(undefined, `${webOrigin}/login`, webOrigin)).toBe(true);
    expect(
      isAllowedBrowserSource(undefined, 'http://localhost:3000.evil.example/', webOrigin),
    ).toBe(false);
  });

  it('rejects a foreign Origin even when Referer looks local', () => {
    expect(isAllowedBrowserSource('https://evil.example', `${webOrigin}/login`, webOrigin)).toBe(
      false,
    );
    expect(isAllowedBrowserSource(webOrigin, undefined, webOrigin)).toBe(true);
  });
});

describe('login DTO', () => {
  it('rejects unknown fields, oversized email and empty credentials', () => {
    expect(
      loginRequestSchema.safeParse({
        email: 'user@example.sgr.local',
        password: 'Dana-SGR-Demo-2026!',
        role: 'ADMIN',
      }).success,
    ).toBe(false);
    expect(
      loginRequestSchema.safeParse({
        email: `${'a'.repeat(255)}@example.sgr.local`,
        password: 'Dana-SGR-Demo-2026!',
      }).success,
    ).toBe(false);
    expect(loginRequestSchema.safeParse({ email: '', password: 'x' }).success).toBe(false);
    expect(
      loginRequestSchema.safeParse({
        email: 'user@example.sgr.local',
        password: 'Dana-SGR-Demo-2026!',
      }).success,
    ).toBe(true);
  });
});

describe('login rate limit dimensions', () => {
  it('limits independently by account and by IP', () => {
    expect(isLoginRateLimited(5, 0, 5, 25)).toBe(true);
    expect(isLoginRateLimited(0, 25, 5, 25)).toBe(true);
    expect(isLoginRateLimited(4, 24, 5, 25)).toBe(false);
  });
});

describe('JSON vs multipart body limits', () => {
  it('keeps a small JSON limit and recognizes only upload routes as multipart', () => {
    expect(JSON_BODY_MAX_BYTES).toBe(64 * 1024);
    expect(isMultipartUploadRoute('/api/acts/:actId/attachments')).toBe(true);
    expect(isMultipartUploadRoute('/api/defects/:defectItemId/attachments')).toBe(true);
    expect(isMultipartUploadRoute('/api/proposals/:proposalId/attachments')).toBe(true);
    expect(isMultipartUploadRoute('/api/attachments/:attachmentId/archive')).toBe(false);
    expect(isMultipartUploadRoute('/api/auth/login')).toBe(false);
  });
});
