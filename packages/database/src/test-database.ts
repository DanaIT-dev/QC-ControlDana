export function assertSafeTestDatabaseUrl(databaseUrl: string): URL {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run integration tests because NODE_ENV=production');
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(
      'Refusing to run integration tests: TEST_DATABASE_URL is not a valid PostgreSQL URL',
    );
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] ?? '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests: database name "${databaseName || '(empty)'}" must end with "_test". ` +
        'Set TEST_DATABASE_URL to a dedicated test database. Development and production databases will not be used.',
    );
  }

  return parsed;
}
