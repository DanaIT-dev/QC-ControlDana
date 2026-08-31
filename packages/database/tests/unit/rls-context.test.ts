import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hmacEqual,
  macRlsContext,
  RLS_CONTEXT_VERSION,
  signUserRlsContext,
  signWorkerRlsContext,
  splitRlsToken,
} from '../../src/rls-context';

const SECRET = 'unit-test-rls-context-secret-value-32';

describe('RLS context tokens', () => {
  it('signs a user token that verifies with HMAC-SHA256', () => {
    const userId = randomUUID();
    const token = signUserRlsContext(
      { userId, sessionVersion: 3, nonce: 'nonce-value', issuedAtMs: 1_700_000_000_000 },
      SECRET,
    );
    const parts = splitRlsToken(token);
    expect(parts).not.toBeNull();
    if (!parts) {
      return;
    }
    expect(parts.body.startsWith(`v${RLS_CONTEXT_VERSION}.user|${userId}|3|`)).toBe(true);
    expect(hmacEqual(parts.mac, macRlsContext(parts.body, SECRET))).toBe(true);
    expect(
      hmacEqual(parts.mac, createHmac('sha256', SECRET).update(parts.body).digest('hex')),
    ).toBe(true);
  });

  it('rejects a forged mac', () => {
    const token = signUserRlsContext(
      { userId: randomUUID(), sessionVersion: 1, nonce: 'nonce-value' },
      SECRET,
    );
    const parts = splitRlsToken(token);
    expect(parts).not.toBeNull();
    if (!parts) {
      return;
    }
    const forged = `${parts.body}.${'a'.repeat(parts.mac.length)}`;
    const forgedParts = splitRlsToken(forged);
    expect(forgedParts).not.toBeNull();
    if (!forgedParts) {
      return;
    }
    expect(hmacEqual(forgedParts.mac, macRlsContext(forgedParts.body, SECRET))).toBe(false);
  });

  it('signs a worker token without a user id', () => {
    const token = signWorkerRlsContext(SECRET, { nonce: 'worker-nonce', issuedAtMs: 10 });
    expect(token.startsWith('v1.worker|10|worker-nonce.')).toBe(true);
  });
});
