export const LOCAL_DEVELOPMENT_REDIS_PASSWORD = 'local-development-only';
export const REDIS_API_ACL_USER = 'sgr_api';
export const REDIS_WORKER_ACL_USER = 'sgr_worker';

export type RedisUrlInspection = {
  protocol: 'redis:' | 'rediss:';
  username: string;
  hostname: string;
  hasPassword: boolean;
};

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isPrivateRedisHost(hostname: string): boolean {
  if (isLoopbackHost(hostname)) {
    return true;
  }
  const host = hostname.replace(/^\[|\]$/g, '');
  if (!host.includes('.')) {
    return true;
  }
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) {
    return true;
  }
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host)) {
    return true;
  }
  return false;
}

function passwordOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return '';
  }
}

export function inspectRedisUrl(url: string): RedisUrlInspection | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      return null;
    }
    return {
      protocol: parsed.protocol,
      username: decodeURIComponent(parsed.username),
      hostname: parsed.hostname,
      hasPassword: parsed.password.length > 0,
    };
  } catch {
    return null;
  }
}

export function redisUrlIssues(
  url: string,
  options: { production: boolean; expectedUsername?: string; name: string },
): string[] {
  const issues: string[] = [];
  const inspected = inspectRedisUrl(url);
  if (!inspected) {
    issues.push(`${options.name} must be a Redis connection string`);
    return issues;
  }
  if (!inspected.username || !inspected.hasPassword) {
    issues.push(`${options.name} requires Redis ACL username and password`);
  }
  if (options.production && passwordOf(url) === LOCAL_DEVELOPMENT_REDIS_PASSWORD) {
    issues.push(`${options.name} must not use the development password`);
  }
  if (
    options.expectedUsername &&
    inspected.username &&
    inspected.username !== options.expectedUsername
  ) {
    issues.push(`${options.name} must use Redis ACL user ${options.expectedUsername}`);
  }
  if (
    options.production &&
    inspected.protocol === 'redis:' &&
    !isPrivateRedisHost(inspected.hostname)
  ) {
    issues.push(`${options.name} must use rediss:// for Redis outside the private network`);
  }
  return issues;
}

export function redisTlsOptions(url: string): { tls?: { rejectUnauthorized: true } } {
  try {
    if (new URL(url).protocol === 'rediss:') {
      return { tls: { rejectUnauthorized: true } };
    }
  } catch {
    return {};
  }
  return {};
}
