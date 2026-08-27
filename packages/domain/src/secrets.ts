export const SENSITIVE_AUDIT_KEYS = [
  'password',
  'passwordHash',
  'temporaryPassword',
  'newPassword',
  'currentPassword',
  'csrfToken',
  'cookie',
  'sessionId',
  'sessionHash',
  'authorization',
  'resetToken',
] as const;

const AUDIT_NON_SECRET_KEYS = new Set(['mustchangepassword', 'passwordchangedat']);

function isSensitiveKey(key: string): boolean {
  const folded = key.toLowerCase();
  if (AUDIT_NON_SECRET_KEYS.has(folded)) {
    return false;
  }
  return SENSITIVE_AUDIT_KEYS.some(
    (secret) => folded === secret.toLowerCase() || folded.includes(secret.toLowerCase()),
  );
}

export function containsSensitiveAuditKey(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsSensitiveAuditKey);
  }
  if (typeof value !== 'object') {
    return false;
  }
  return Object.entries(value).some(
    ([key, nested]) => isSensitiveKey(key) || containsSensitiveAuditKey(nested),
  );
}

export function assertAuditPayloadSafe(value: unknown): void {
  if (containsSensitiveAuditKey(value)) {
    throw new Error('Sensitive key must not be written to AuditLog');
  }
}

export function omitSensitiveKeys<T extends Record<string, unknown>>(input: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    result[key] = value;
  }
  return result as T;
}
