const WEAK_SECRET_MARKERS = [
  'local-development-only',
  'local-dev',
  'not-for-production',
  '_dev_password',
  'sgr_minio_admin',
  'dana-sgr-demo',
  'changeme',
  'change-me',
  'password123',
] as const;

export function isWeakSecret(value: string | undefined | null): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized.length < 16) {
    return true;
  }
  return WEAK_SECRET_MARKERS.some((marker) => normalized.includes(marker));
}

export function weakSecretMessage(label: string): string {
  return `${label} is missing or too weak for production`;
}

export function passwordFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return '';
  }
}

export function databaseNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname.replace(/^\//, '');
    return decodeURIComponent(pathname.split('/')[0] ?? '');
  } catch {
    return '';
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'mailpit';
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes('.')) {
    return true;
  }
  if (host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (/^10(?:\.\d{1,3}){3}$/.test(host) || /^192\.168(?:\.\d{1,3}){2}$/.test(host)) {
    return true;
  }
  return /^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host);
}
