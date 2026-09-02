import { existsSync } from 'node:fs';
import { stdout } from 'node:process';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from '@sgr-registry/config';
import { createOwnerPrismaClient } from '../src/index';
import { assertObjectsImportDatabaseTarget } from '../src/objects-import-target';
import { reconcileDirectoryEngineerLinks } from '../src/reconcile-object-engineers';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile, override: false });

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function printHelp(): void {
  stdout.write(`Reconcile Excel responsible-engineer names with user accounts.

Dry-run (default):
  pnpm objects:reconcile-engineers

Local development write:
  SGR_OBJECTS_IMPORT_CONFIRM=sgr_registry \\
    pnpm objects:reconcile-engineers --apply --confirm-database=sgr_registry
`);
}

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) {
    printHelp();
    return;
  }
  const apply = hasFlag('apply');
  const config = loadConfig();
  const databaseUrl = config.MIGRATION_DATABASE_URL;
  const target = assertObjectsImportDatabaseTarget({
    nodeEnv: config.NODE_ENV,
    databaseUrl,
    apply,
    confirmDatabase: argValue('confirm-database'),
    confirmProduction: hasFlag('confirm-production'),
    confirmEnv: process.env.SGR_OBJECTS_IMPORT_CONFIRM,
    stdinIsTty: Boolean(process.stdin.isTTY),
  });
  const prisma = createOwnerPrismaClient(databaseUrl);
  try {
    if (!apply) {
      stdout.write(`${JSON.stringify({ applied: false, target: target.databaseName }, null, 2)}\n`);
      return;
    }
    const report = await reconcileDirectoryEngineerLinks(prisma, {
      actorUserId: null,
      actorName: 'objects-engineer-reconcile',
      requestId: null,
      source: 'SYSTEM',
    });
    stdout.write(
      `${JSON.stringify({ applied: true, target: target.databaseName, ...report }, null, 2)}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'engineer reconcile failed');
  process.exit(1);
});
