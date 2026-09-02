import { isAbsolute, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import {
  OBJECTS_REQUIRED_HEADERS,
  OBJECTS_SHEET_NAME,
  ValidationError,
  assertObjectsSheetName,
  parseObjectsSheetMatrix,
  type ObjectsWorkbookParseResult,
} from '@sgr-registry/domain';

export function assertLocalObjectsWorkbookPath(filePath: string): string {
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

export async function readObjectsWorkbook(filePath: string): Promise<ObjectsWorkbookParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(assertLocalObjectsWorkbookPath(filePath));
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  assertObjectsSheetName(sheetNames);
  const sheet = workbook.getWorksheet(OBJECTS_SHEET_NAME);
  if (!sheet) {
    throw new ValidationError('sheet', `Лист «${OBJECTS_SHEET_NAME}» не найден`);
  }
  const maxRow = Math.max(sheet.rowCount, 1);
  const rows: unknown[][] = [];
  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    rows.push(
      Array.from(
        { length: OBJECTS_REQUIRED_HEADERS.length },
        (_, index) => row.getCell(index + 1).value,
      ),
    );
  }
  return parseObjectsSheetMatrix(rows);
}
