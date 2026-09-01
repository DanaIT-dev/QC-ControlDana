import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from '@sgr-registry/config';
import { createOwnerPrismaClient, ensureTestSuperAdmin } from '../src/index';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile, override: false });

async function main(): Promise<void> {
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password) {
    throw new Error('SEED_DEMO_PASSWORD is required to create the synthetic test SUPER_ADMIN');
  }
  const config = loadConfig();
  const owner = createOwnerPrismaClient(config.MIGRATION_DATABASE_URL);
  try {
    const user = await ensureTestSuperAdmin({ owner, password });
    process.stdout.write(`${user.email}\n`);
  } finally {
    await owner.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'ensure-test-super-admin failed';
  console.error(message);
  process.exit(1);
});
