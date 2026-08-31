import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const RLS_CONTEXT_VERSION = 1;
export const RLS_CONTEXT_MAX_AGE_MS = 60_000;

export type RlsContextKind = 'user' | 'worker';

export interface UserRlsContextInput {
  userId: string;
  sessionVersion: number;
  nonce?: string;
  issuedAtMs?: number;
}

export function signUserRlsContext(input: UserRlsContextInput, secret: string): string {
  const nonce = input.nonce && input.nonce.length > 0 ? input.nonce : randomUUID();
  const issuedAtMs = input.issuedAtMs ?? Date.now();
  const payload = [
    'user',
    input.userId,
    String(input.sessionVersion),
    String(issuedAtMs),
    nonce,
  ].join('|');
  return signPayload(payload, secret);
}

export function signWorkerRlsContext(
  secret: string,
  input: { nonce?: string; issuedAtMs?: number } = {},
): string {
  const nonce = input.nonce && input.nonce.length > 0 ? input.nonce : randomUUID();
  const issuedAtMs = input.issuedAtMs ?? Date.now();
  const payload = ['worker', String(issuedAtMs), nonce].join('|');
  return signPayload(payload, secret);
}

function signPayload(payload: string, secret: string): string {
  const body = `v${RLS_CONTEXT_VERSION}.${payload}`;
  const mac = createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${mac}`;
}

export function macRlsContext(tokenWithoutMac: string, secret: string): string {
  return createHmac('sha256', secret).update(tokenWithoutMac).digest('hex');
}

export function splitRlsToken(token: string): { body: string; mac: string } | null {
  const lastDot = token.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === token.length - 1) {
    return null;
  }
  return { body: token.slice(0, lastDot), mac: token.slice(lastDot + 1) };
}

export function hmacEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
