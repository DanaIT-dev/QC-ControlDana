import { isAbsolute, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import {
  ACTS_REGISTRY_SHEET_NAME,
  ORGANIZATIONS_SHEET_NAME,
  ValidationError,
  WORK_TYPES_SHEET_NAME,
} from '@sgr-registry/domain';

export interface DirectoriesWorkbookSheets {
  sheetNames: string[];
  workTypeValues: unknown[];
  organizationRows: unknown[][];
  actRows: unknown[][];
}

function assertLocalWorkbookPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new ValidationError('file', 'Укажите путь к Excel-файлу');
  }
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('file:')) {
    throw new ValidationError('file', 'Путь к файлу не может быть URL');
  }
  if (!isAbsolute(trimmed)) {
    throw new ValidationError('file', 'Укажите абсолютный путь к Excel-файлу');
  }
  return resolve(trimmed);
}

function sheetMatrix(sheet: ExcelJS.Worksheet | undefined, columns: number): unknown[][] {
  if (!sheet) {
    return [];
  }
  const maxRow = Math.max(sheet.rowCount, sheet.actualRowCount || 0, 1);
  const rows: unknown[][] = [];
  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    rows.push(Array.from({ length: columns }, (_, index) => row.getCell(index + 1).value));
  }
  return rows;
}

function columnA(sheet: ExcelJS.Worksheet | undefined): unknown[] {
  if (!sheet) {
    return [];
  }
  const maxRow = Math.max(sheet.rowCount, sheet.actualRowCount || 0, 0);
  const values: unknown[] = [];
  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    values.push(sheet.getRow(rowNumber).getCell(1).value);
  }
  return values;
}

export async function readDirectoriesWorkbook(
  filePath: string,
): Promise<DirectoriesWorkbookSheets> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(assertLocalWorkbookPath(filePath));
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  return {
    sheetNames,
    workTypeValues: columnA(workbook.getWorksheet(WORK_TYPES_SHEET_NAME)),
    organizationRows: sheetMatrix(workbook.getWorksheet(ORGANIZATIONS_SHEET_NAME), 9),
    actRows: sheetMatrix(workbook.getWorksheet(ACTS_REGISTRY_SHEET_NAME), 23),
  };
}
