export function postgresUrlWithoutSchema(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('schema');
  return parsed.toString();
}

export function withDatabaseName(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

export function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, '').split('/')[0] ?? '');
}

export function postgresUserOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return '';
  }
}

export function postgresHostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function remapDatabaseUrl(roleUrl: string, targetUrl: string): string {
  const role = new URL(roleUrl);
  const target = new URL(targetUrl);
  role.pathname = target.pathname;
  return role.toString();
}

export function redisLogicalDbOf(url: string): number {
  try {
    const path = new URL(url).pathname.replace(/^\//, '');
    if (!path) {
      return 0;
    }
    const value = Number.parseInt(path.split('/')[0] ?? '0', 10);
    return Number.isInteger(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function remapRedisLogicalDb(url: string, logicalDb: number): string {
  const parsed = new URL(url);
  parsed.pathname = `/${logicalDb}`;
  return parsed.toString();
}
