import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from '@sgr-registry/config';
import { createOwnerPrismaClient } from '../src/index';
import { assertDirectoriesImportDatabaseTarget } from '../src/directories-import-target';
import { importReferenceDirectories } from '../src/directories-import';
import { readDirectoriesWorkbook } from '../src/directories-xlsx';

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
  stdout.write(`Import operational directories (defect types, work types, organizations).

Dry-run (default):
  pnpm directories:import --file="/absolute/path/to.xlsx"

Local development write:
  SGR_DIRECTORIES_IMPORT_CONFIRM=sgr_registry \\
    pnpm directories:import --file="/absolute/path/to.xlsx" --apply --confirm-database=sgr_registry

Defect types always come from APPROVED_DEFECT_TYPES_V1.
Excel is not copied into Git. The file path is not written to AuditLog.
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
  const config = loadConfig();
  const databaseUrl = config.MIGRATION_DATABASE_URL;
  const target = assertDirectoriesImportDatabaseTarget({
    nodeEnv: config.NODE_ENV,
    databaseUrl,
    apply,
    confirmDatabase: argValue('confirm-database'),
    confirmProduction: hasFlag('confirm-production'),
    confirmEnv: process.env.SGR_DIRECTORIES_IMPORT_CONFIRM,
    stdinIsTty: Boolean(stdin.isTTY),
  });

  if (apply && stdin.isTTY) {
    stdout.write(`Target database: ${target.databaseName} @ ${target.host}\n`);
    const typed = (await prompt(`Type ${target.databaseName} to import: `)).trim();
    if (typed !== target.databaseName) {
      throw new Error('Confirmation does not match the target database name.');
    }
  }

  const sheets = await readDirectoriesWorkbook(file);
  const prisma = createOwnerPrismaClient(databaseUrl);
  try {
    const report = await importReferenceDirectories({ prisma, sheets, apply });
    stdout.write(
      `${JSON.stringify(
        {
          applied: report.applied,
          target: { database: target.databaseName, host: target.host, nodeEnv: config.NODE_ENV },
          sheets: sheets.sheetNames,
          defectTypes: report.defectTypes,
          workTypes: report.workTypes,
          organizations: report.organizations,
          usersUnchanged: report.usersCountBefore === report.usersCountAfter,
          objectsUnchanged: report.objectsCountBefore === report.objectsCountAfter,
          actsUnchanged: report.actsCountBefore === report.actsCountAfter,
          credentialsUnchanged: report.credentialsCountBefore === report.credentialsCountAfter,
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
  const message = error instanceof Error ? error.message : 'Directories import failed';
  stdout.write(`${message}\n`);
  process.exitCode = 1;
});
