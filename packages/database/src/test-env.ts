import { remapDatabaseUrl } from './database-url';

export function applyTestDatabaseEnv(
  testDatabaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) {
      throw new Error(`${name} is required when remapping test database URLs`);
    }
    return value;
  };
  env.DATABASE_URL = remapDatabaseUrl(required('DATABASE_URL'), testDatabaseUrl);
  env.AUTH_DATABASE_URL = remapDatabaseUrl(required('AUTH_DATABASE_URL'), testDatabaseUrl);
  env.WORKER_DATABASE_URL = remapDatabaseUrl(required('WORKER_DATABASE_URL'), testDatabaseUrl);
  env.MIGRATION_DATABASE_URL = remapDatabaseUrl(
    required('MIGRATION_DATABASE_URL'),
    testDatabaseUrl,
  );
}
