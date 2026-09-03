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
  'sessionToken',
  'sessionVersion',
  'authorization',
  'resetToken',
  'objectKey',
  'storageKey',
  'bucket',
  'accessKey',
  'secretKey',
  'minio',
  'clamav',
  'rawScannerResponse',
  'scanTrace',
  'smtpPassword',
  'smtpPass',
  'SMTP_PASSWORD',
  'jwtSecret',
  'privateKey',
  'connectionString',
  'DATABASE_URL',
  'REDIS_URL',
  'apiToken',
  'apiKey',
  'stackTrace',
] as const;

const AUDIT_NON_SECRET_KEYS = new Set([
  'mustchangepassword',
  'passwordchangedat',
  'passwordconfigured',
  'credentialconfigured',
  'activesessionscount',
]);

export const SENSITIVE_API_RESPONSE_KEYS = [
  'password',
  'passwordHash',
  'temporaryPassword',
  'newPassword',
  'currentPassword',
  'csrfToken',
  'cookie',
  'cookies',
  'sessionId',
  'sessionHash',
  'sessionToken',
  'sessionVersion',
  'authorization',
  'resetToken',
  'objectKey',
  'storageKey',
  'accessKey',
  'accessKeyId',
  'secretKey',
  'secretAccessKey',
  'privateKey',
  'jwtSecret',
  'connectionString',
  'DATABASE_URL',
  'REDIS_URL',
  'SMTP_PASSWORD',
  'smtpPassword',
  'smtpPass',
  'apiToken',
  'apiKey',
  'stack',
  'stackTrace',
  'rawScannerResponse',
] as const;

const SENSITIVE_API_KEY_SET = new Set(SENSITIVE_API_RESPONSE_KEYS.map((key) => key.toLowerCase()));

const SECRET_VALUE_PATTERN =
  /postgres(ql)?:\/\/|redis:\/\/|\$argon2|BEGIN [A-Z ]*PRIVATE KEY|mongodb(\+srv)?:\/\//i;

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

export function scrubSensitiveValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(scrubSensitiveValue);
  }
  if (typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    result[key] = scrubSensitiveValue(nested);
  }
  return result;
}

export function omitSensitiveKeys<T extends Record<string, unknown>>(input: T): T {
  return scrubSensitiveValue(input) as T;
}

export function findSensitiveApiResponseLeaks(value: unknown, path = '$'): string[] {
  const leaks: string[] = [];
  collectSensitiveApiResponseLeaks(value, path, leaks);
  return leaks;
}

function collectSensitiveApiResponseLeaks(value: unknown, path: string, leaks: string[]): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERN.test(value)) {
      leaks.push(path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectSensitiveApiResponseLeaks(item, `${path}[${index}]`, leaks);
    });
    return;
  }
  if (typeof value !== 'object') {
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (SENSITIVE_API_KEY_SET.has(key.toLowerCase())) {
      leaks.push(childPath);
      continue;
    }
    collectSensitiveApiResponseLeaks(nested, childPath, leaks);
  }
}
