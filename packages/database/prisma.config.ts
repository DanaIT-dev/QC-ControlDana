import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

const repoRoot = resolve(__dirname, '../..');
if (process.env.NODE_ENV === 'production') {
  if (!process.env.MIGRATION_DATABASE_URL) {
    throw new Error(
      'MIGRATION_DATABASE_URL is required in production. Refusing to load an example env file.',
    );
  }
} else {
  const envFile = existsSync(resolve(repoRoot, '.env'))
    ? resolve(repoRoot, '.env')
    : resolve(repoRoot, '.env.example');
  loadDotenv({ path: envFile, override: !process.env.MIGRATION_DATABASE_URL });
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || '',
  },
});
