import { describe, expect, it } from 'vitest';
import { buildWebContentSecurityPolicy, isProductionScriptCsp } from '../lib/csp';

describe('web content security policy', () => {
  it('keeps production free of unsafe-eval and blocks framing', () => {
    const policy = buildWebContentSecurityPolicy({ nonce: 'abc123', isDevelopment: false });
    expect(isProductionScriptCsp(policy)).toBe(true);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).toContain("font-src 'self'");
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).toContain("'nonce-abc123'");
  });

  it('isolates development eval to the development policy', () => {
    const policy = buildWebContentSecurityPolicy({ nonce: 'devnonce', isDevelopment: true });
    expect(policy).toContain('unsafe-eval');
    expect(policy).toContain('ws://localhost:3000');
    expect(isProductionScriptCsp(policy)).toBe(false);
  });
});
