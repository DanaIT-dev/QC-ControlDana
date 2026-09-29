import { describe, expect, it } from 'vitest';
import { redactLogText } from './secrets';

describe('log redaction', () => {
  it('removes connection strings and password hashes from log text', () => {
    const raw = [
      'postgresql://sgr_app_user:sgr-app-production-secret@postgres:5432/sgr_registry',
      'redis://sgr_api:prod-redis-api-not-dev@redis:6379/0',
      '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$hash',
      'session-id=opaque-session-token',
    ].join(' ');
    const redacted = redactLogText(raw);
    expect(redacted).not.toContain('sgr-app-production-secret');
    expect(redacted).not.toContain('prod-redis-api-not-dev');
    expect(redacted).not.toContain('$argon2id$');
    expect(redacted).not.toContain('opaque-session-token');
    expect(redacted).toContain('postgresql://[redacted]');
    expect(redacted).toContain('redis://[redacted]');
  });
});
