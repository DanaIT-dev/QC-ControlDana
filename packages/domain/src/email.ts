const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  const normalized = normalizeEmail(value);
  return normalized.length > 0 && normalized.length <= 254 && EMAIL_PATTERN.test(normalized);
}

export function maskEmail(value: string): string {
  const normalized = normalizeEmail(value);
  const at = normalized.indexOf('@');
  if (at <= 0 || at === normalized.length - 1) {
    return '***';
  }
  return `${normalized.slice(0, 1)}***@${normalized.slice(at + 1)}`;
}
