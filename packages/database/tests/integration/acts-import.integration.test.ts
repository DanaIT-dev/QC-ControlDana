import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LEGACY_ACT_SOURCE_SYSTEM,
  CONFIRMED_LAST_FIRST_TOKEN_ORDER,
  personNameWriteFields,
} from '@sgr-registry/domain';
import { createOwnerPrismaClient, createPrismaClient } from '../../src/client';
import { withAuthenticatedDbContext } from '../../src/authenticated-context';
import { importLegacyActs, rollbackLegacyActsImportBatch } from '../../src/acts-import';
import { reconcileImportedEngineerReferences } from '../../src/reconcile-imported-engineers';
import { readLegacyActsWorkbook } from '../../src/acts-xlsx';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const appUrl = process.env.DATABASE_URL ?? '';
const secret = process.env.RLS_CONTEXT_SECRET ?? '';
assertSafeTestDatabaseUrl(databaseUrl);
assertSafeTestDatabaseUrl(appUrl);
const prisma = createOwnerPrismaClient(databaseUrl);
const appPrisma = createPrismaClient(appUrl);
const MARKER = `actimp-${randomUUID().slice(0, 8)}`;
const BITRIX_A = `https://bitrix.bir.by/doc/${MARKER}-a`;
const BITRIX_B = `https://bitrix.bir.by/doc/${MARKER}-b`;

const HEADERS = [
  '№ акта',
  'Форма акта',
  'Статус',
  'Объект',
  'Адрес объекта',
  'Номер / наименование помещения',
  'Вид дефекта',
  'Заказчик',
  'Виновная организация',
  'Ответственный инженер',
  'Дата составления',
  'Срок устранения',
  'Претензия',
  'Срок устранения по претензии',
  'Третья сторона (предложение А)',
  'Цена (предложение А)',
  'Третья сторона (предложение Б)',
  'Цена (предложение Б)',
  'Третья сторона (предложение В)',
  'Цена (предложение В)',
  'Срок устранения третьей ст.',
  'Ссылка на документ',
  'Примечания',
];

async function writeFixture(
  path: string,
  rows: Array<Array<unknown | { text: string; hyperlink: string }>>,
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Реестр актов');
  sheet.getCell(1, 1).value = 'Реестр';
  HEADERS.forEach((header, index) => {
    sheet.getCell(2, index + 1).value = header;
  });
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      const cell = sheet.getCell(rowIndex + 4, columnIndex + 1);
      if (value && typeof value === 'object' && 'hyperlink' in (value as object)) {
        const link = value as { text: string; hyperlink: string };
        cell.value = { text: link.text, hyperlink: link.hyperlink };
      } else {
        cell.value = value as ExcelJS.CellValue;
      }
    });
  });
  await workbook.xlsx.writeFile(path);
}

const ENGINEER_A_NAME = 'Имптестов Дмитрий Сергеевич';
const ENGINEER_B_NAME = 'Имптестова Елена Ивановна';
const ENGINEER_A_SHORT = 'Имптестов Д.С.';
const ENGINEER_B_SHORT = 'Имптестова Е.И.';

function baseRow(overrides: Record<number, unknown> = {}): unknown[] {
  const cells: unknown[] = Array.from({ length: 23 }, () => null);
  cells[1] = 'С-23';
  cells[3] = `${MARKER} объект`;
  cells[4] = { formula: 'IFERROR(VLOOKUP(D4,#REF!,2,FALSE),"")' };
  cells[5] = 'Лобби';
  cells[6] = 'Замокание / течь';
  cells[7] = `${MARKER} заказчик`;
  cells[8] = `${MARKER} подрядчик`;
  cells[9] = ENGINEER_A_SHORT;
  cells[10] = new Date(Date.UTC(2026, 6, 31));
  cells[11] = '5 рабочих дней';
  cells[21] = { text: BITRIX_A, hyperlink: BITRIX_A };
  for (const [index, value] of Object.entries(overrides)) {
    cells[Number(index)] = value;
  }
  return cells;
}

describe('legacy acts importer', () => {
  const createdUserIds: string[] = [];
  let objectId = '';
  let engineerId = '';
  let engineerTwoId = '';

  beforeAll(async () => {
    const object = await prisma.propertyObject.create({
      data: { name: `${MARKER} объект`, address: 'ул. Каталожная, 1' },
    });
    objectId = object.id;
    await prisma.organization.create({
      data: {
        officialName: `${MARKER} заказчик`,
        roles: { create: [{ role: 'CUSTOMER' }] },
      },
    });
    await prisma.user.deleteMany({
      where: { fullName: { in: [ENGINEER_A_NAME, ENGINEER_B_NAME] } },
    });
    const engineer = await prisma.user.create({
      data: {
        ...personNameWriteFields(ENGINEER_A_NAME, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
        email: `${MARKER}.orlov@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
        status: 'ACTIVE',
      },
    });
    engineerId = engineer.id;
    createdUserIds.push(engineer.id);
    const second = await prisma.user.create({
      data: {
        ...personNameWriteFields(ENGINEER_B_NAME, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
        email: `${MARKER}.krylova@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
        status: 'ACTIVE',
      },
    });
    engineerTwoId = second.id;
    createdUserIds.push(second.id);
  });

  afterAll(async () => {
    const acts = await prisma.act.findMany({
      where: { sourceFileName: { contains: MARKER } },
      select: { id: true, importBatchId: true },
    });
    const actIds = acts.map((row) => row.id);
    const defectIds = (
      await prisma.defectItem.findMany({
        where: { actId: { in: actIds } },
        select: { id: true },
      })
    ).map((row) => row.id);
    const createdOrgs = await prisma.organization.findMany({
      where: { officialName: { startsWith: MARKER } },
      select: { id: true },
    });
    const createdOrgIds = createdOrgs.map((row) => row.id);
    await prisma.notificationEvent.deleteMany({
      where: {
        occurrenceKey: { in: createdOrgIds.map((id) => `ORGANIZATION_DETAILS_INCOMPLETE:${id}`) },
      },
    });
    if (createdOrgIds.length > 0) {
      await prisma.outboxEvent.deleteMany({
        where: {
          type: 'ORGANIZATION_DETAILS_INCOMPLETE',
          OR: createdOrgIds.map((id) => ({
            payload: { path: ['organizationId'], equals: id },
          })),
        },
      });
    }
    await prisma.importedEngineerReference.deleteMany({
      where: { defectItemId: { in: defectIds } },
    });
    await prisma.defectItemEngineer.deleteMany({ where: { defectItemId: { in: defectIds } } });
    await prisma.defectItemLiableOrganization.deleteMany({
      where: { defectItemId: { in: defectIds } },
    });
    await prisma.defectItem.deleteMany({ where: { id: { in: defectIds } } });
    await prisma.act.deleteMany({ where: { id: { in: actIds } } });
    await prisma.importBatch.deleteMany({
      where: {
        OR: [
          { id: { in: acts.map((row) => row.importBatchId).filter(Boolean) as string[] } },
          { sourceFileName: { contains: MARKER } },
        ],
      },
    });
    await prisma.organizationRoleAssignment.deleteMany({
      where: { organizationId: { in: createdOrgIds } },
    });
    await prisma.organizationWorkType.deleteMany({
      where: { organizationId: { in: createdOrgIds } },
    });
    await prisma.organization.deleteMany({
      where: { id: { in: createdOrgIds } },
    });
    await prisma.propertyObject.deleteMany({ where: { id: objectId } });
    await prisma.defectType.deleteMany({
      where: { name: { startsWith: `${MARKER} вид` } },
    });
    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only',
    );
    try {
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            ...(createdUserIds.length > 0 ? [{ actorUserId: { in: createdUserIds } }] : []),
            ...(createdUserIds.length > 0 ? [{ entityId: { in: createdUserIds } }] : []),
          ],
        },
      });
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only',
      );
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await appPrisma.$disconnect();
    await prisma.$disconnect();
  });

  it('applies grouped rows idempotently and blocks conflicting payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sgr-acts-import-'));
    const file = join(dir, `${MARKER}.xlsx`);
    try {
      await writeFixture(file, [
        baseRow({ 8: `${MARKER} подрядчик`, 9: ENGINEER_A_SHORT }),
        baseRow({ 8: `${MARKER} вторая`, 9: ENGINEER_B_SHORT }),
        baseRow({ 5: 154, 6: `${MARKER} вид новый`, 11: new Date(Date.UTC(2026, 8, 1)) }),
        baseRow({
          0: '12',
          2: 'В работе',
          5: '–',
          11: 'Не установлен',
          21: { text: BITRIX_B, hyperlink: BITRIX_B },
        }),
        baseRow({
          0: '12',
          21: { text: 'https://bitrix.bir.by/doc/other', hyperlink: 'https://evil.example/doc' },
        }),
      ]);
      const workbook = await readLegacyActsWorkbook(file);
      expect(workbook.parse.brokenAddressFormulas).toBeGreaterThan(0);
      expect(workbook.parse.groupedActs.length).toBeGreaterThanOrEqual(2);
      const usersBefore = await prisma.user.count();
      const objectsBefore = await prisma.propertyObject.count();
      const first = await importLegacyActs({
        prisma,
        workbook,
        apply: false,
        databaseName: 'sgr_registry_test',
        environment: 'test',
      });
      expect(first.plan.blockingIssues.some((item) => item.includes('Ссылка'))).toBe(true);

      await writeFixture(file, [
        baseRow({ 8: `${MARKER} подрядчик`, 9: ENGINEER_A_SHORT }),
        baseRow({ 8: `${MARKER} вторая`, 9: ENGINEER_B_SHORT }),
        baseRow({ 5: 154, 6: `${MARKER} вид новый`, 11: new Date(Date.UTC(2026, 8, 1)) }),
        baseRow({
          0: '12',
          2: 'В работе',
          5: '–',
          11: 'Не установлен',
          21: { text: BITRIX_B, hyperlink: BITRIX_B },
        }),
      ]);
      const valid = await readLegacyActsWorkbook(file);
      const applied = await importLegacyActs({
        prisma,
        workbook: valid,
        apply: true,
        databaseName: 'sgr_registry_test',
        environment: 'test',
      });
      expect(applied.applied).toBe(true);
      expect(applied.created.acts).toBe(2);
      expect(applied.created.defects).toBe(3);
      expect(await prisma.user.count()).toBe(usersBefore);
      expect(await prisma.propertyObject.count()).toBe(objectsBefore);
      const imported = await prisma.act.findMany({
        where: {
          sourceSystem: LEGACY_ACT_SOURCE_SYSTEM,
          sourceExternalUrl: { startsWith: BITRIX_A.slice(0, 40) },
        },
        include: {
          defectItems: { include: { liableOrganizations: true, responsibleEngineers: true } },
        },
      });
      expect(imported.some((act) => act.status === 'IMPORTED_UNSPECIFIED')).toBe(true);
      expect(imported.some((act) => act.status === 'IN_PROGRESS' && act.startedAt === null)).toBe(
        true,
      );
      const multi = imported.find((act) => act.sourceExternalUrl === BITRIX_A);
      const lobby = multi?.defectItems.find((item) => item.location === 'Лобби');
      expect(lobby?.createdAt.getTime()).toBe(multi?.issuedOn.getTime());
      expect(multi?.createdAt.getTime()).toBe(multi?.issuedOn.getTime());
      expect(lobby?.claimDetails).toBeNull();
      expect(lobby?.liableOrganizations.length).toBe(2);
      expect(lobby?.responsibleEngineers.map((item) => item.userId).sort()).toEqual(
        [engineerId, engineerTwoId].sort(),
      );
      expect(lobby?.workTypeId).toBeNull();
      const proposals = await prisma.proposal.count({
        where: { defectItemId: { in: multi?.defectItems.map((item) => item.id) ?? [] } },
      });
      expect(proposals).toBe(0);

      const repeat = await importLegacyActs({
        prisma,
        workbook: valid,
        apply: true,
        databaseName: 'sgr_registry_test',
        environment: 'test',
      });
      expect(repeat.created.acts).toBe(0);
      expect(repeat.created.defects).toBe(0);
      expect(repeat.unchanged.acts).toBe(2);

      const started = imported.find((act) => act.status === 'IMPORTED_UNSPECIFIED');
      expect(started).toBeTruthy();
      const notificationsBefore = await prisma.outboxEvent.count();
      await prisma.act.update({
        where: { id: started!.id },
        data: { status: 'IN_PROGRESS', startedAt: new Date() },
      });
      const operational = await importLegacyActs({
        prisma,
        workbook: valid,
        apply: false,
        databaseName: 'sgr_registry_test',
        environment: 'test',
      });
      expect(operational.plan.payloadConflicts).toHaveLength(0);
      expect(operational.unchanged.acts).toBe(2);
      expect(operational.unchanged.defects).toBe(3);
      const startedAfter = await prisma.act.findUniqueOrThrow({ where: { id: started!.id } });
      expect(startedAfter.status).toBe('IN_PROGRESS');
      expect(startedAfter.sourceStatusRaw).toBe(started!.sourceStatusRaw);
      const operationalApply = await importLegacyActs({
        prisma,
        workbook: valid,
        apply: true,
        databaseName: 'sgr_registry_test',
        environment: 'test',
      });
      expect(operationalApply.created.acts).toBe(0);
      expect(await prisma.outboxEvent.count()).toBe(notificationsBefore);
      expect((await prisma.act.findUniqueOrThrow({ where: { id: started!.id } })).status).toBe(
        'IN_PROGRESS',
      );

      await writeFixture(file, [baseRow({ 1: 'С-1' })]);
      const changed = await readLegacyActsWorkbook(file);
      const conflict = await importLegacyActs({
        prisma,
        workbook: changed,
        apply: false,
        databaseName: 'sgr_registry_test',
        environment: 'test',
      });
      expect(conflict.plan.payloadConflicts.length).toBeGreaterThan(0);
      await expect(
        importLegacyActs({
          prisma,
          workbook: changed,
          apply: true,
          databaseName: 'sgr_registry_test',
          environment: 'test',
        }),
      ).rejects.toThrow(/заблокирован/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('imports unmatched engineers as unresolved references without creating users', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sgr-acts-unmatched-'));
    const file = join(dir, `${MARKER}-unmatched.xlsx`);
    try {
      await writeFixture(file, [
        baseRow({
          9: 'Лазарчик Е.В.',
          21: { text: `${BITRIX_A}-x`, hyperlink: `${BITRIX_A}-x` },
        }),
      ]);
      const workbook = await readLegacyActsWorkbook(file);
      const usersBefore = await prisma.user.count();
      const dryRun = await importLegacyActs({
        prisma,
        workbook,
        apply: false,
        databaseName: 'sgr_registry_test',
        environment: 'test',
      });
      expect(dryRun.plan.blockingIssues.some((item) => item.includes('Лазарчик'))).toBe(false);
      expect(dryRun.plan.warnings.some((item) => item.includes('Лазарчик'))).toBe(true);
      const applied = await importLegacyActs({
        prisma,
        workbook,
        apply: true,
        databaseName: 'sgr_registry_test',
        environment: 'test',
      });
      expect(applied.applied).toBe(true);
      expect(applied.created.unresolvedEngineerReferences).toBe(1);
      expect(await prisma.user.count()).toBe(usersBefore);
      const refs = await prisma.importedEngineerReference.findMany({
        where: { sourceNameRaw: 'Лазарчик Е.В.' },
      });
      expect(refs).toHaveLength(1);
      expect(refs[0]?.resolutionStatus).toBe('UNMATCHED');
      expect(refs[0]?.matchedUserId).toBeNull();
      const assignments = await prisma.defectItemEngineer.count({
        where: { defectItemId: refs[0]!.defectItemId },
      });
      expect(assignments).toBe(0);
      const objectEngineers = await prisma.propertyObjectEngineer.count({
        where: { propertyObjectId: objectId },
      });
      expect(objectEngineers).toBe(0);
      expect(secret.length).toBeGreaterThanOrEqual(32);
      const outsider = await prisma.user.create({
        data: {
          ...personNameWriteFields('Посторонний Инженер', CONFIRMED_LAST_FIRST_TOKEN_ORDER),
          email: `${MARKER}.outsider@example.sgr.local`,
          role: 'RESPONSIBLE_ENGINEER',
          status: 'ACTIVE',
          sessionVersion: 1,
        },
      });
      createdUserIds.push(outsider.id);
      const importedActId = (
        await prisma.defectItem.findUniqueOrThrow({
          where: { id: refs[0]!.defectItemId },
          select: { actId: true },
        })
      ).actId;
      const hidden = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: outsider.id, sessionVersion: 1 },
        callback: (tx) => tx.act.findMany({ where: { id: importedActId } }),
      });
      expect(hidden).toHaveLength(0);
      expect(
        await prisma.defectItemEngineer.count({
          where: { defectItemId: refs[0]!.defectItemId, userId: outsider.id },
        }),
      ).toBe(0);
      const repeat = await importLegacyActs({
        prisma,
        workbook,
        apply: true,
        databaseName: 'sgr_registry_test',
        environment: 'test',
      });
      expect(repeat.created.acts).toBe(0);
      expect(repeat.created.unresolvedEngineerReferences).toBe(0);
      expect(
        await prisma.importedEngineerReference.count({ where: { sourceNameRaw: 'Лазарчик Е.В.' } }),
      ).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rolls back only the selected batch and later resolves unmatched engineers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sgr-acts-rollback-'));
    const file = join(dir, `${MARKER}-rollback.xlsx`);
    try {
      await writeFixture(file, [
        baseRow({
          9: 'Минтюк К.А.',
          21: { text: `${BITRIX_A}-rb`, hyperlink: `${BITRIX_A}-rb` },
        }),
      ]);
      const workbook = await readLegacyActsWorkbook(file);
      const usersBefore = await prisma.user.count();
      const objectsBefore = await prisma.propertyObject.count();
      const passwordBefore = await prisma.userCredential.findMany({
        select: { userId: true, passwordHash: true },
        orderBy: { userId: 'asc' },
      });
      const existingActCount = await prisma.act.count({
        where: { importBatchId: null },
      });
      const applied = await importLegacyActs({
        prisma,
        workbook,
        apply: true,
        databaseName: 'sgr_registry_test',
        environment: 'test',
      });
      expect(applied.importBatchId).toBeTruthy();
      const batchId = applied.importBatchId!;
      const rolled = await rollbackLegacyActsImportBatch({
        prisma,
        importBatchId: batchId,
        databaseName: 'sgr_registry_test',
        environment: 'test',
      });
      expect(rolled.rolledBack).toBe(true);
      expect(rolled.deleted.acts).toBe(1);
      expect(rolled.deleted.unresolvedEngineerReferences).toBe(1);
      expect(await prisma.user.count()).toBe(usersBefore);
      expect(await prisma.propertyObject.count()).toBe(objectsBefore);
      expect(await prisma.act.count({ where: { importBatchId: null } })).toBe(existingActCount);
      const passwordAfter = await prisma.userCredential.findMany({
        select: { userId: true, passwordHash: true },
        orderBy: { userId: 'asc' },
      });
      expect(passwordAfter).toEqual(passwordBefore);
      const again = await rollbackLegacyActsImportBatch({
        prisma,
        importBatchId: batchId,
        databaseName: 'sgr_registry_test',
        environment: 'test',
      });
      expect(again.alreadyRolledBack).toBe(true);
      await expect(
        rollbackLegacyActsImportBatch({
          prisma,
          importBatchId: batchId,
          databaseName: 'sgr_registry_test',
          environment: 'production',
        }),
      ).rejects.toThrow(/production/);

      const second = await importLegacyActs({
        prisma,
        workbook,
        apply: true,
        databaseName: 'sgr_registry_test',
        environment: 'test',
      });
      const created = await prisma.user.create({
        data: {
          ...personNameWriteFields('Минтюк Константин Андреевич', CONFIRMED_LAST_FIRST_TOKEN_ORDER),
          email: `${MARKER}.mintyuk@example.sgr.local`,
          role: 'RESPONSIBLE_ENGINEER',
          status: 'ACTIVE',
        },
      });
      createdUserIds.push(created.id);
      const reconciled = await prisma.$transaction((tx) =>
        reconcileImportedEngineerReferences(tx, {
          actorUserId: created.id,
          actorName: created.fullName,
          requestId: null,
          source: 'SYSTEM',
          targetUserId: created.id,
        }),
      );
      expect(reconciled.resolved).toBe(1);
      const ref = await prisma.importedEngineerReference.findFirst({
        where: { importBatchId: second.importBatchId! },
      });
      expect(ref?.resolutionStatus).toBe('RESOLVED');
      expect(ref?.matchedUserId).toBe(created.id);
      expect(ref?.sourceNameRaw).toBe('Минтюк К.А.');
      const assignments = await prisma.defectItemEngineer.count({
        where: { defectItemId: ref!.defectItemId, userId: created.id },
      });
      expect(assignments).toBe(1);
      const againReconcile = await prisma.$transaction((tx) =>
        reconcileImportedEngineerReferences(tx, {
          actorUserId: created.id,
          actorName: created.fullName,
          requestId: null,
          source: 'SYSTEM',
          targetUserId: created.id,
        }),
      );
      expect(againReconcile.resolved).toBe(0);
      expect(
        await prisma.defectItemEngineer.count({
          where: { defectItemId: ref!.defectItemId, userId: created.id },
        }),
      ).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
