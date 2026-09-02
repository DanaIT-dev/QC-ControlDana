import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { OBJECTS_SHEET_NAME } from '@sgr-registry/domain';
import { assertLocalObjectsWorkbookPath, readObjectsWorkbook } from '../../src/objects-xlsx';
import { assertObjectsImportDatabaseTarget } from '../../src/objects-import-target';

async function writeWorkbook(path: string, extraSheet = true): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  if (extraSheet) {
    const ignored = workbook.addWorksheet('Реестр актов');
    ignored.getCell('A1').value = 'не импортировать';
  }
  const sheet = workbook.addWorksheet(OBJECTS_SHEET_NAME);
  sheet.getCell('A1').value = 'Объекты';
  sheet.getCell('B1').value = 'Адреса';
  sheet.getCell('C1').value = 'Дата приёмки в эксплуатацию';
  sheet.getCell('D1').value = 'Дата завершения гарантийного срока';
  sheet.getCell('E1').value = 'Ответственный инженер';
  sheet.getCell('A2').value = '2.1 «Волна»';
  sheet.getCell('B2').value = 'пр-т Мира, 1';
  sheet.getCell('C2').value = new Date(Date.UTC(2020, 5, 1));
  sheet.getCell('D2').value = {
    formula: 'IF(C2="","",EDATE(C2,60))',
    result: new Date(Date.UTC(2025, 5, 1)),
  };
  sheet.getCell('A3').value = '2.1 «Волна» (1-й ПК)';
  sheet.getCell('B3').value = 'пр-т Мира, 1';
  await workbook.xlsx.writeFile(path);
}

describe('objects xlsx reader', () => {
  it('rejects HTTP paths and relative files', () => {
    expect(() => assertLocalObjectsWorkbookPath('https://example.test/file.xlsx')).toThrow(/URL/);
    expect(() => assertLocalObjectsWorkbookPath('objects.xlsx')).toThrow(/абсолютный/);
  });

  it('reads only the Объекты sheet and uses cached formula results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sgr-objects-xlsx-'));
    const file = join(dir, 'objects.xlsx');
    try {
      await writeWorkbook(file);
      const parsed = await readObjectsWorkbook(file);
      expect(parsed.sheetName).toBe(OBJECTS_SHEET_NAME);
      expect(parsed.uniqueRows).toHaveLength(2);
      expect(parsed.uniqueRows[0]?.warrantyEndsAt).toBe('2025-06-01');
      expect(parsed.uniqueRows[0]?.commissionedAt).toBe('2020-06-01');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('objects import target', () => {
  it('allows a local development apply with matching confirmation', () => {
    const target = assertObjectsImportDatabaseTarget({
      nodeEnv: 'development',
      databaseUrl: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry',
      apply: true,
      confirmDatabase: 'sgr_registry',
      confirmEnv: 'sgr_registry',
    });
    expect(target.databaseName).toBe('sgr_registry');
  });

  it('refuses production without an explicit production confirmation', () => {
    expect(() =>
      assertObjectsImportDatabaseTarget({
        nodeEnv: 'production',
        databaseUrl: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_prod',
        apply: true,
        confirmDatabase: 'sgr_prod',
        confirmEnv: 'sgr_prod',
      }),
    ).toThrow(/Production import/);
  });

  it('refuses a remote host in development', () => {
    expect(() =>
      assertObjectsImportDatabaseTarget({
        nodeEnv: 'development',
        databaseUrl: 'postgresql://sgr_migrator:x@db.internal:5432/sgr_registry',
        apply: false,
      }),
    ).toThrow(/localhost/);
  });
});
