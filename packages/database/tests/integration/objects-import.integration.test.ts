import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OBJECTS_SHEET_NAME, OBJECTS_SOURCE_SYSTEM } from '@sgr-registry/domain';
import { createOwnerPrismaClient } from '../../src/client';
import { importPropertyObjects } from '../../src/objects-import';
import { readObjectsWorkbook } from '../../src/objects-xlsx';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
assertSafeTestDatabaseUrl(databaseUrl);
const prisma = createOwnerPrismaClient(databaseUrl);
const MARKER = `objimp-${randomUUID().slice(0, 8)}`;

async function writeFixture(path: string, rows: unknown[][]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Реестр актов').getCell('A1').value = 'skip';
  const sheet = workbook.addWorksheet(OBJECTS_SHEET_NAME);
  const headers = [
    'Объекты',
    'Адреса',
    'Дата приёмки в эксплуатацию',
    'Дата завершения гарантийного срока',
    'Ответственный инженер',
  ];
  headers.forEach((header, index) => {
    sheet.getCell(1, index + 1).value = header;
  });
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      sheet.getCell(rowIndex + 2, columnIndex + 1).value = value as ExcelJS.CellValue;
    });
  });
  await workbook.xlsx.writeFile(path);
}

describe('property objects importer', () => {
  const createdObjectIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdActIds: string[] = [];
  let existingObjectId = '';
  let customerId = '';
  let actObjectId = '';

  beforeAll(async () => {
    const existing = await prisma.propertyObject.create({
      data: {
        name: `${MARKER} существующий конфликт`,
        address: 'ул. Старая, 1',
      },
    });
    existingObjectId = existing.id;
    createdObjectIds.push(existing.id);

    const customer = await prisma.organization.create({
      data: {
        officialName: `${MARKER} заказчик`,
        postalAddress: 'addr',
        email: `${MARKER}.org@example.sgr.local`,
        phone: '1',
        contactPerson: 'C',
      },
    });
    customerId = customer.id;

    const actObject = await prisma.propertyObject.create({
      data: { name: `${MARKER} объект с актом`, address: 'ул. Актовая, 1' },
    });
    actObjectId = actObject.id;
    createdObjectIds.push(actObject.id);

    const act = await prisma.act.create({
      data: {
        officialNumber: `${MARKER}-С-1-2026-000001`,
        formCode: 'S1',
        year: 2026,
        sequence: 1,
        objectId: actObject.id,
        customerOrganizationId: customer.id,
        status: 'NEW',
        issuedOn: new Date('2026-08-26T12:00:00.000Z'),
      },
    });
    createdActIds.push(act.id);

    const engineer = await prisma.user.create({
      data: {
        fullName: 'Василевич М.В.',
        email: `${MARKER}.vasilevich@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
      },
    });
    createdUserIds.push(engineer.id);
  });

  afterAll(async () => {
    await prisma.act.deleteMany({ where: { id: { in: createdActIds } } });
    await prisma.propertyObjectEngineer.deleteMany({
      where: { propertyObjectId: { in: createdObjectIds } },
    });
    await prisma.propertyObject.deleteMany({
      where: { OR: [{ id: { in: createdObjectIds } }, { name: { startsWith: MARKER } }] },
    });
    await prisma.organization.deleteMany({ where: { id: customerId } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it('imports unique rows, skips a full duplicate, and stays idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sgr-objects-import-'));
    const file = join(dir, 'objects.xlsx');
    try {
      await writeFixture(file, [
        [
          `${MARKER} 2.1 «Волна»`,
          'пр-т Мира, 1',
          new Date(Date.UTC(2020, 5, 1)),
          null,
          'Василевич М.В.',
        ],
        [`${MARKER} 2.1 «Волна» (1-й ПК)`, 'пр-т Мира, 1', null, null, null],
        [
          `${MARKER} 2.1 «Волна» (1-й ПК – перенесённые виды работ)`,
          'пр-т Мира, 1',
          null,
          null,
          null,
        ],
        [`${MARKER} 10.2 «Бора-Бора»`, 'ул. Братская, 15', null, null, null],
        [`${MARKER} 10.2 «Бора-Бора»`, 'ул. Братская, 15', null, null, null],
        [`${MARKER} без адреса`, null, null, null, null],
      ]);
      const parsed = await readObjectsWorkbook(file);
      expect(parsed.uniqueRows).toHaveLength(5);
      expect(parsed.duplicates).toHaveLength(1);

      const usersBefore = await prisma.user.count();
      const credentialsBefore = await prisma.userCredential.count();
      const assignmentsBefore = await prisma.propertyObjectEngineer.count();
      const first = await importPropertyObjects({ prisma, parsed, apply: true });
      createdObjectIds.push(
        ...(
          await prisma.propertyObject.findMany({
            where: { name: { startsWith: MARKER } },
            select: { id: true },
          })
        ).map((row) => row.id),
      );
      expect(first.created).toBe(5);
      expect(first.duplicatesSkipped).toBe(1);
      expect(first.responsibleEngineers.linked).toContain('Василевич М.В.');
      expect(first.responsibleEngineers.accessAssignmentsCreated).toBe(0);
      expect(await prisma.user.count()).toBe(usersBefore);
      expect(await prisma.userCredential.count()).toBe(credentialsBefore);
      expect(await prisma.propertyObjectEngineer.count()).toBe(assignmentsBefore);

      const act = await prisma.act.findUniqueOrThrow({ where: { id: createdActIds[0] } });
      expect(act.objectId).toBe(actObjectId);

      const second = await importPropertyObjects({ prisma, parsed, apply: true });
      expect(second.created).toBe(0);
      expect(second.unchanged).toBe(5);
      expect(second.duplicatesSkipped).toBe(1);

      const emptyAddress = await prisma.propertyObject.findFirst({
        where: { name: `${MARKER} без адреса` },
      });
      expect(emptyAddress?.address).toBeNull();
      expect(emptyAddress?.sourceSystem).toBe(OBJECTS_SOURCE_SYSTEM);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not overwrite an existing object when the name matches a different address', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sgr-objects-conflict-'));
    const file = join(dir, 'objects.xlsx');
    try {
      await writeFixture(file, [
        [`${MARKER} существующий конфликт`, 'ул. Новая, 9', null, null, null],
      ]);
      const parsed = await readObjectsWorkbook(file);
      const report = await importPropertyObjects({ prisma, parsed, apply: true });
      expect(report.created).toBe(0);
      expect(report.conflicts).toHaveLength(1);
      const existing = await prisma.propertyObject.findUniqueOrThrow({
        where: { id: existingObjectId },
      });
      expect(existing.address).toBe('ул. Старая, 1');
      expect(existing.sourceImportKey).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rolls back the transaction when a unique name collision appears mid-import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sgr-objects-rollback-'));
    const file = join(dir, 'objects.xlsx');
    try {
      await writeFixture(file, [
        [`${MARKER} rollback same`, 'ул. Первая, 1', null, null, null],
        [`${MARKER} rollback same`, 'ул. Вторая, 2', null, null, null],
      ]);
      const parsed = await readObjectsWorkbook(file);
      await expect(importPropertyObjects({ prisma, parsed, apply: true })).rejects.toBeTruthy();
      const leftover = await prisma.propertyObject.findMany({
        where: { name: `${MARKER} rollback same` },
      });
      expect(leftover).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
