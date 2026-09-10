import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  classifyEngineerMatch,
  foldMatchKey,
  importedEngineerMatchKey,
  parseSourceSurnameInitials,
  CONFIRMED_LAST_FIRST_TOKEN_ORDER,
  personNameWriteFields,
} from '@sgr-registry/domain';
import { createOwnerPrismaClient, databaseNameOf } from '../src/index';
import { assertE2eDatabaseTarget, E2E_DATABASE_NAME } from '../src/e2e-target';
import { readLegacyActsWorkbook } from '../src/acts-xlsx';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile, override: false });

const KEEP_UNMATCHED = new Set(['Лазарчик Е.В.', 'Минтюк К.А.', 'Головач О.В.', 'Тихомиров А.О.']);

const GIVEN_BY_INITIAL: Record<string, string> = {
  а: 'Александр',
  б: 'Борис',
  в: 'Виктор',
  г: 'Геннадий',
  д: 'Дмитрий',
  е: 'Елена',
  ё: 'Елена',
  и: 'Иван',
  к: 'Константин',
  л: 'Леонид',
  м: 'Михаил',
  н: 'Николай',
  о: 'Олег',
  п: 'Павел',
  р: 'Роман',
  с: 'Сергей',
  т: 'Татьяна',
  ю: 'Юрий',
  я: 'Ярослав',
};

const PATRONYMIC_BY_INITIAL: Record<string, string> = {
  а: 'Александрович',
  б: 'Борисович',
  в: 'Викторович',
  г: 'Геннадьевич',
  д: 'Дмитриевич',
  е: 'Евгеньевич',
  ё: 'Евгеньевич',
  и: 'Иванович',
  к: 'Константинович',
  л: 'Леонидович',
  м: 'Михайлович',
  н: 'Николаевич',
  о: 'Олегович',
  п: 'Павлович',
  с: 'Сергеевич',
  т: 'Тихонович',
  ю: 'Юрьевич',
  я: 'Ярославович',
};

function officialNameFromSource(sourceName: string): string {
  const parsed = parseSourceSurnameInitials(sourceName);
  if (!parsed) {
    return sourceName;
  }
  const surname = sourceName.normalize('NFKC').trim().replace(/\s+/g, ' ').split(' ')[0]!;
  const firstName = GIVEN_BY_INITIAL[parsed.firstInitial] ?? 'Иван';
  if (!parsed.patronymicInitial) {
    return `${surname} ${firstName}`;
  }
  const middleName = PATRONYMIC_BY_INITIAL[parsed.patronymicInitial] ?? 'Иванович';
  return `${surname} ${firstName} ${middleName}`;
}

function uniqueSourceNames(workbook: Awaited<ReturnType<typeof readLegacyActsWorkbook>>): string[] {
  const names = new Set<string>();
  for (const act of workbook.parse.groupedActs) {
    for (const defect of act.defects) {
      for (const name of defect.engineerNames) {
        const trimmed = name.normalize('NFKC').trim().replace(/\s+/g, ' ');
        if (trimmed) {
          names.add(trimmed);
        }
      }
    }
  }
  return [...names];
}

async function main(): Promise<void> {
  assertE2eDatabaseTarget();
  const file = process.argv[2];
  if (!file) {
    throw new Error('Usage: tsx scripts/prepare-e2e-legacy-engineers.ts /absolute/path.xlsx');
  }
  const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? '';
  if (databaseNameOf(databaseUrl) !== E2E_DATABASE_NAME) {
    throw new Error('E2E engineer fixture must use sgr_registry_e2e');
  }
  const workbook = await readLegacyActsWorkbook(file);
  const prisma = createOwnerPrismaClient(databaseUrl);
  try {
    const existingObjects = await prisma.propertyObject.findMany({
      select: { id: true, name: true },
    });
    let objectsCreated = 0;
    for (const act of workbook.parse.groupedActs) {
      const key = foldMatchKey(act.objectNameRaw);
      const matches = existingObjects.filter((item) => foldMatchKey(item.name) === key);
      if (matches.length > 1) {
        throw new Error(`Ambiguous e2e object match for ${act.objectNameRaw}`);
      }
      if (matches.length === 1) {
        continue;
      }
      const createdObject = await prisma.propertyObject.create({
        data: { name: act.objectNameRaw },
      });
      existingObjects.push({ id: createdObject.id, name: createdObject.name });
      objectsCreated += 1;
    }
    const existing = await prisma.user.findMany({
      where: { role: 'RESPONSIBLE_ENGINEER' },
      select: { id: true, fullName: true, role: true, status: true },
    });
    let created = 0;
    let skipped = 0;
    for (const sourceName of uniqueSourceNames(workbook)) {
      if (KEEP_UNMATCHED.has(sourceName)) {
        skipped += 1;
        continue;
      }
      const classified = classifyEngineerMatch(sourceName, existing);
      if (classified.result === 'AMBIGUOUS') {
        throw new Error(`Ambiguous e2e engineer match for ${sourceName}`);
      }
      if (classified.result === 'MATCHED') {
        skipped += 1;
        continue;
      }
      const official = officialNameFromSource(sourceName);
      const key = Buffer.from(importedEngineerMatchKey(sourceName), 'utf8')
        .toString('hex')
        .slice(0, 32);
      const user = await prisma.user.create({
        data: {
          ...personNameWriteFields(official, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
          email: `legacy.${key}@example.sgr.local`,
          role: 'RESPONSIBLE_ENGINEER',
          status: 'ACTIVE',
        },
      });
      existing.push({
        id: user.id,
        fullName: user.fullName,
        role: user.role,
        status: user.status,
      });
      created += 1;
    }
    process.stdout.write(
      `${JSON.stringify({ created, skipped, objectsCreated, keepUnmatched: [...KEEP_UNMATCHED] })}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main();
