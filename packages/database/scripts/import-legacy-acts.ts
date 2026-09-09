import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from '@sgr-registry/config';
import { formatPersonShort, KNOWN_LEGACY_REGISTRY_SHA256 } from '@sgr-registry/domain';
import { createOwnerPrismaClient, databaseNameOf } from '../src/index';
import { assertActsImportDatabaseTarget } from '../src/acts-import-target';
import { importLegacyActs, rollbackLegacyActsImportBatch } from '../src/acts-import';
import { readLegacyActsWorkbook } from '../src/acts-xlsx';

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
  stdout.write(`Import historical defect acts from the «Реестр актов» sheet.

Dry-run (default):
  pnpm acts:import -- --file="/absolute/path/to.xlsx"

Local development write:
  SGR_ACTS_IMPORT_CONFIRM=sgr_registry \\
    pnpm acts:import -- --file="/absolute/path/to.xlsx" --apply --confirm-database=sgr_registry --expect-sha256=${KNOWN_LEGACY_REGISTRY_SHA256}

Rollback a development batch:
  pnpm acts:import -- --rollback-batch=<importBatchId> --confirm-database=sgr_registry

Excel formulas are not executed. Documents are not downloaded.
Production import is disabled.
`);
}

function publicReport(input: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(input);
  if (/passwordHash|csrfToken|"secret"|sessionToken/i.test(json)) {
    throw new Error('Refusing to print a report that contains sensitive fields');
  }
  return input;
}

function printReport(input: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify(publicReport(input), null, 2)}\n`);
}

function reportPayload(input: {
  report: Awaited<ReturnType<typeof importLegacyActs>>;
  workbook: Awaited<ReturnType<typeof readLegacyActsWorkbook>>;
  target: { databaseName: string; host: string };
  nodeEnv: string;
  databaseUrl: string;
}): Record<string, unknown> {
  const { report, workbook, target, nodeEnv, databaseUrl } = input;
  return {
    applied: report.applied,
    target: { database: target.databaseName, host: target.host, nodeEnv },
    source: {
      fileName: workbook.fileName,
      sha256: workbook.sha256,
      sizeBytes: workbook.sizeBytes,
      sheetNames: workbook.sheetNames,
      sheet: workbook.parse.sheetName,
      headers: workbook.parse.headers,
      sourceRows: workbook.parse.sourceRows,
      uniqueDocumentUrls: workbook.parse.uniqueDocumentUrls,
      repeatedUrlGroups: workbook.parse.repeatedUrlGroups,
      brokenAddressFormulas: workbook.parse.brokenAddressFormulas,
      expectedActs: workbook.parse.groupedActs.length,
      expectedDefects: workbook.parse.groupedActs.reduce((sum, act) => sum + act.defects.length, 0),
    },
    mapping: {
      objects: report.plan.objectMatches.map((item) => ({
        sourceName: item.sourceName,
        result: item.result,
        matches: item.matches.map((match) => match.name),
      })),
      customers: report.plan.customerMatches.map((item) => ({
        sourceName: item.sourceName,
        result: item.result,
        matches: item.matches.map((match) => match.officialName),
      })),
      liableOrganizations: report.plan.liableMatches.map((item) => ({
        sourceName: item.sourceName,
        result: item.result,
        matches: item.matches.map((match) => match.officialName),
      })),
      engineers: report.plan.engineerMatches.map((item) => ({
        sourceName: item.sourceName,
        result: item.result,
        matches: item.matches.map((match) => formatPersonShort(match.fullName)),
      })),
      defectTypes: report.plan.defectTypeMatches.map((item) => ({
        sourceName: item.sourceName,
        result: item.result,
        matches: item.matches.map((match) => match.name),
      })),
      customersToCreate: report.plan.customersToCreate,
      liableOrganizationsToCreate: report.plan.liableOrganizationsToCreate,
      defectTypesToCreate: report.plan.defectTypesToCreate,
      workTypesAssigned: 0,
    },
    blockingIssues: report.plan.blockingIssues,
    warnings: report.plan.warnings,
    engineerLinks: {
      matched: report.applied ? report.created.engineerLinks : report.plan.engineerLinksToCreate,
      unresolved: report.applied
        ? report.created.unresolvedEngineerReferences
        : report.plan.unresolvedEngineerLinksToCreate,
    },
    uniqueEngineers: {
      matched: report.plan.engineerMatches.filter((item) => item.result === 'MATCHED').length,
      unmatched: report.plan.engineerMatches.filter((item) => item.result === 'UNMATCHED').length,
      ambiguous: report.plan.engineerMatches.filter((item) => item.result === 'AMBIGUOUS').length,
    },
    groupingConflicts: report.plan.groupingConflicts,
    payloadConflicts: report.plan.payloadConflicts,
    created: report.created,
    unchanged: report.unchanged,
    importBatchId: report.importBatchId,
    preservation: report.preservation,
    preservationAfter: report.preservationAfter ?? null,
    productionImported: false,
    databaseNameConfirmed: databaseNameOf(databaseUrl),
  };
}

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) {
    printHelp();
    return;
  }
  const rollbackBatch = argValue('rollback-batch');
  const file = argValue('file');
  const apply = hasFlag('apply');
  if (apply && hasFlag('dry-run')) {
    throw new Error('Use either --dry-run or --apply');
  }
  if (rollbackBatch && (file || apply)) {
    throw new Error('Rollback cannot be combined with --file or --apply');
  }
  const config = loadConfig();
  const databaseUrl = config.MIGRATION_DATABASE_URL;
  const target = assertActsImportDatabaseTarget({
    nodeEnv: config.NODE_ENV,
    databaseUrl,
    apply: apply || Boolean(rollbackBatch),
    confirmDatabase: argValue('confirm-database'),
    confirmProduction: hasFlag('confirm-production'),
    confirmEnv: process.env.SGR_ACTS_IMPORT_CONFIRM,
    stdinIsTty: Boolean(stdin.isTTY),
  });
  const prisma = createOwnerPrismaClient(databaseUrl);
  try {
    if (rollbackBatch) {
      const report = await rollbackLegacyActsImportBatch({
        prisma,
        importBatchId: rollbackBatch,
        databaseName: target.databaseName,
        environment: config.NODE_ENV,
      });
      printReport({
        rolledBack: report.rolledBack,
        alreadyRolledBack: report.alreadyRolledBack,
        importBatchId: report.importBatchId,
        target: { database: target.databaseName, host: target.host, nodeEnv: config.NODE_ENV },
        deleted: report.deleted,
        productionImported: false,
        databaseNameConfirmed: databaseNameOf(databaseUrl),
      });
      return;
    }
    if (!file) {
      printHelp();
      throw new Error('Missing --file=/absolute/path/to.xlsx');
    }
    const workbook = await readLegacyActsWorkbook(file);
    const expectSha256 = argValue('expect-sha256');
    if (apply && target.databaseName === 'sgr_registry') {
      const requiredHash = expectSha256 ?? KNOWN_LEGACY_REGISTRY_SHA256;
      if (workbook.sha256 !== requiredHash) {
        throw new Error(
          `SHA-256 файла ${workbook.sha256} не совпадает с ожидаемым ${requiredHash}`,
        );
      }
    }
    const dryRun = await importLegacyActs({
      prisma,
      workbook,
      apply: false,
      databaseName: target.databaseName,
      environment: config.NODE_ENV,
      expectSha256,
    });
    if (!apply) {
      printReport(
        reportPayload({
          report: dryRun,
          workbook,
          target,
          nodeEnv: config.NODE_ENV,
          databaseUrl,
        }),
      );
      if (dryRun.plan.blockingIssues.length > 0) {
        process.exitCode = 1;
      }
      return;
    }
    if (dryRun.plan.blockingIssues.length > 0) {
      printReport(
        reportPayload({
          report: dryRun,
          workbook,
          target,
          nodeEnv: config.NODE_ENV,
          databaseUrl,
        }),
      );
      throw new Error(`Импорт заблокирован:\n${dryRun.plan.blockingIssues.join('\n')}`);
    }
    if (stdin.isTTY) {
      stdout.write(`Target database: ${target.databaseName} @ ${target.host}\n`);
      stdout.write(`SHA-256: ${workbook.sha256}\n`);
      const typed = (await prompt(`Type ${target.databaseName} to import: `)).trim();
      if (typed !== target.databaseName) {
        throw new Error('Confirmation does not match the target database name.');
      }
    }
    const report = await importLegacyActs({
      prisma,
      workbook,
      apply: true,
      databaseName: target.databaseName,
      environment: config.NODE_ENV,
      expectSha256,
    });
    printReport(
      reportPayload({
        report,
        workbook,
        target,
        nodeEnv: config.NODE_ENV,
        databaseUrl,
      }),
    );
    if (report.plan.blockingIssues.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'acts import failed';
  console.error(message);
  process.exit(1);
});
