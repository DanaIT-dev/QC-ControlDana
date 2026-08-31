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

export function remapDatabaseUrl(roleUrl: string, targetUrl: string): string {
  const role = new URL(roleUrl);
  const target = new URL(targetUrl);
  role.pathname = target.pathname;
  return role.toString();
}
