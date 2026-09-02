import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  ACTS_REGISTRY_SHEET_NAME,
  ORGANIZATIONS_SHEET_NAME,
  WORK_TYPES_SHEET_NAME,
} from '@sgr-registry/domain';
import { readDirectoriesWorkbook } from '../../src/directories-xlsx';
import { assertDirectoriesImportDatabaseTarget } from '../../src/directories-import-target';

async function writeWorkbook(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet(WORK_TYPES_SHEET_NAME);
  const orgs = workbook.addWorksheet(ORGANIZATIONS_SHEET_NAME);
  orgs.getCell('A1').value = 'Наименование организации';
  orgs.getCell('D1').value = 'Вид выполняемых работ';
  orgs.getCell('A2').value = 'ООО «Окна»';
  orgs.getCell('D2').value = 'Окна';
  const acts = workbook.addWorksheet(ACTS_REGISTRY_SHEET_NAME);
  acts.getCell('A1').value = 'Заказчик';
  acts.getCell('B1').value = 'Виновная организация';
  acts.getCell('A2').value = 'ИООО «ДАНА АСТРА»';
  acts.getCell('B2').value = 'ООО «Окна»';
  await workbook.xlsx.writeFile(path);
}

describe('directories xlsx reader', () => {
  it('rejects HTTP and relative paths', async () => {
    await expect(readDirectoriesWorkbook('https://example.test/file.xlsx')).rejects.toThrow(/URL/);
    await expect(readDirectoriesWorkbook('dirs.xlsx')).rejects.toThrow(/абсолютный/);
  });

  it('reads work types, organizations and the acts registry without copying the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sgr-dirs-xlsx-'));
    const file = join(dir, 'dirs.xlsx');
    try {
      await writeWorkbook(file);
      const parsed = await readDirectoriesWorkbook(file);
      expect(parsed.sheetNames).toEqual(
        expect.arrayContaining([
          WORK_TYPES_SHEET_NAME,
          ORGANIZATIONS_SHEET_NAME,
          ACTS_REGISTRY_SHEET_NAME,
        ]),
      );
      expect(parsed.organizationRows[1]?.[0]).toBe('ООО «Окна»');
      expect(parsed.actRows[0]?.[0]).toBe('Заказчик');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('directories import target', () => {
  it('allows a local development apply with matching confirmation', () => {
    const target = assertDirectoriesImportDatabaseTarget({
      nodeEnv: 'development',
      databaseUrl: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry',
      apply: true,
      confirmDatabase: 'sgr_registry',
      confirmEnv: 'sgr_registry',
    });
    expect(target.databaseName).toBe('sgr_registry');
  });

  it('refuses production and remote hosts', () => {
    expect(() =>
      assertDirectoriesImportDatabaseTarget({
        nodeEnv: 'production',
        databaseUrl: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry',
        apply: true,
        confirmDatabase: 'sgr_registry',
        confirmEnv: 'sgr_registry',
      }),
    ).toThrow(/Production/);
    expect(() =>
      assertDirectoriesImportDatabaseTarget({
        nodeEnv: 'development',
        databaseUrl: 'postgresql://sgr_migrator:x@db.example:5432/sgr_registry',
        apply: true,
        confirmDatabase: 'sgr_registry',
        confirmEnv: 'sgr_registry',
      }),
    ).toThrow(/localhost/);
  });

  it('allows a dedicated test database apply', () => {
    const target = assertDirectoriesImportDatabaseTarget({
      nodeEnv: 'test',
      databaseUrl: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry_test',
      apply: true,
      confirmDatabase: 'sgr_registry_test',
    });
    expect(target.databaseName).toBe('sgr_registry_test');
  });
});
