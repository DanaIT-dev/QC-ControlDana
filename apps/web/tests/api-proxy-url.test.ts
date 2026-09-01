import { describe, expect, it } from 'vitest';
import { buildUpstreamApiUrl, isSafeApiPathSegment } from '../lib/api-proxy-url';

describe('BFF API proxy path', () => {
  it('keeps upstream requests under /api and rejects traversal segments', () => {
    expect(isSafeApiPathSegment('auth')).toBe(true);
    expect(isSafeApiPathSegment('login')).toBe(true);
    expect(isSafeApiPathSegment('..')).toBe(false);
    expect(isSafeApiPathSegment('.')).toBe(false);
    expect(isSafeApiPathSegment('%2e%2e')).toBe(false);
    expect(isSafeApiPathSegment('..%2fetc')).toBe(false);

    const ok = buildUpstreamApiUrl(
      'http://127.0.0.1:3001',
      ['auth', 'login'],
      new URLSearchParams(),
    );
    expect(ok.href).toBe('http://127.0.0.1:3001/api/auth/login');

    expect(() =>
      buildUpstreamApiUrl('http://127.0.0.1:3001', ['..', 'health'], new URLSearchParams()),
    ).toThrow('invalid_api_path');
  });
});
