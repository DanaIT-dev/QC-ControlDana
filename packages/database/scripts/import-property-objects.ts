import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from '@sgr-registry/config';
import { createOwnerPrismaClient } from '../src/index';
import { assertObjectsImportDatabaseTarget } from '../src/objects-import-target';
import { importPropertyObjects } from '../src/objects-import';
import { readObjectsWorkbook } from '../src/objects-xlsx';

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

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await new Promise((resolvePrompt) => {
      rl.question(question, (answer) => resolvePrompt(answer));
    });
  } finally {
    rl.close();
  }
}

function printHelp(): void {
  stdout.write(`Import property objects from the «Объекты» sheet.

Dry-run (default):
  pnpm objects:import --file="/absolute/path/to.xlsx"

Local development write:
  SGR_OBJECTS_IMPORT_CONFIRM=sgr_registry \\
    pnpm objects:import --file="/absolute/path/to.xlsx" --apply --confirm-database=sgr_registry

Future production write (do not run from this task):
  NODE_ENV=production \\
  SGR_OBJECTS_IMPORT_CONFIRM=<exact-production-db-name> \\
    pnpm objects:import --file="/secure/path.xlsx" --apply --confirm-database=<exact-production-db-name> --confirm-production

The file path must be a local absolute path. HTTP(S) URLs are rejected.
Only the «Объекты» sheet is read. Excel formulas are not executed.
`);
}

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) {
    printHelp();
    return;
  }
  const file = argValue('file');
  if (!file) {
    printHelp();
    throw new Error('Missing --file=/absolute/path/to.xlsx');
  }
  const apply = hasFlag('apply');
  const expectUniqueRaw = argValue('expect-unique');
  const expectUnique = expectUniqueRaw ? Number.parseInt(expectUniqueRaw, 10) : undefined;
  const config = loadConfig();
  const databaseUrl = config.MIGRATION_DATABASE_URL;
  const target = assertObjectsImportDatabaseTarget({
    nodeEnv: config.NODE_ENV,
    databaseUrl,
    apply,
    confirmDatabase: argValue('confirm-database'),
    confirmProduction: hasFlag('confirm-production'),
    confirmEnv: process.env.SGR_OBJECTS_IMPORT_CONFIRM,
    stdinIsTty: Boolean(stdin.isTTY),
  });

  if (apply && stdin.isTTY) {
    stdout.write(`Target database: ${target.databaseName} @ ${target.host}\n`);
    const typed = (await prompt(`Type ${target.databaseName} to import: `)).trim();
    if (typed !== target.databaseName) {
      throw new Error('Confirmation does not match the target database name.');
    }
  }

  const parsed = await readObjectsWorkbook(file);
  const prisma = createOwnerPrismaClient(databaseUrl);
  try {
    const report = await importPropertyObjects({
      prisma,
      parsed,
      apply,
      expectUnique: Number.isInteger(expectUnique) ? expectUnique : undefined,
    });
    stdout.write(
      `${JSON.stringify(
        {
          applied: report.applied,
          target: { database: target.databaseName, host: target.host, nodeEnv: config.NODE_ENV },
          source: {
            sheet: parsed.sheetName,
            headers: parsed.headers,
            sourceRows: parsed.sourceRows,
            blankRows: parsed.blankRows,
            duplicates: parsed.duplicates,
            uniqueRows: parsed.uniqueRows.length,
          },
          dryRun: {
            existingObjects: report.plan.existingCount,
            matched: report.plan.matched,
            create: report.plan.create,
            update: report.plan.update,
            unchanged: report.plan.unchanged,
            outsideExcel: report.plan.outsideExcel,
            duplicatesSkipped: report.plan.duplicatesSkipped,
            conflicts: report.plan.conflicts.map((item) => ({
              sourceRow: item.sourceRow,
              reason: item.reason,
            })),
          },
          import: apply
            ? {
                created: report.created,
                updated: report.updated,
                unchanged: report.unchanged,
                duplicatesSkipped: report.duplicatesSkipped,
              }
            : null,
          responsibleEngineers: report.responsibleEngineers,
          usersUnchanged: report.usersCountBefore === report.usersCountAfter,
          credentialsUnchanged: report.credentialsCountBefore === report.credentialsCountAfter,
          assignmentsUnchanged: report.assignmentCountBefore === report.assignmentCountAfter,
          productionImported: false,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'objects import failed';
  console.error(message);
  process.exit(1);
});
