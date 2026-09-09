import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import {
  ACTS_REGISTRY_SHEET_NAME,
  LEGACY_ACTS_MAX_FILE_BYTES,
  LEGACY_ACTS_MAX_ROWS,
  LEGACY_ACTS_MAX_SHEETS,
  LEGACY_ACTS_REQUIRED_HEADERS,
  ValidationError,
  assertLegacyActsSheetName,
  parseLegacyActsSheetMatrix,
  type LegacyActsSheetCell,
  type LegacyActsWorkbookParseResult,
} from '@sgr-registry/domain';

export interface LegacyActsWorkbookFile {
  parse: LegacyActsWorkbookParseResult;
  sha256: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  sheetNames: string[];
}

export function assertLocalActsWorkbookPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new ValidationError('file', 'Укажите путь к Excel-файлу');
  }
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('file:')) {
    throw new ValidationError('file', 'Путь к файлу не может быть URL');
  }
  if (trimmed.includes('\0') || trimmed.includes('..')) {
    throw new ValidationError('file', 'Некорректный путь к Excel-файлу');
  }
  if (!isAbsolute(trimmed)) {
    throw new ValidationError('file', 'Укажите абсолютный путь к Excel-файлу');
  }
  return resolve(trimmed);
}

export async function readLegacyActsWorkbook(filePath: string): Promise<LegacyActsWorkbookFile> {
  const resolved = assertLocalActsWorkbookPath(filePath);
  const stats = statSync(resolved);
  if (!stats.isFile()) {
    throw new ValidationError('file', 'Укажите файл Excel');
  }
  if (stats.size > LEGACY_ACTS_MAX_FILE_BYTES) {
    throw new ValidationError('file', 'Файл Excel слишком большой');
  }
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(resolved);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(resolved);
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  if (sheetNames.length === 0 || sheetNames.length > LEGACY_ACTS_MAX_SHEETS) {
    throw new ValidationError('sheet', 'Некорректное число листов Excel');
  }
  assertLegacyActsSheetName(sheetNames);
  const sheet = workbook.getWorksheet(ACTS_REGISTRY_SHEET_NAME);
  if (!sheet) {
    throw new ValidationError('sheet', `Лист «${ACTS_REGISTRY_SHEET_NAME}» не найден`);
  }
  const maxRow = Math.max(sheet.rowCount, 1);
  if (maxRow > LEGACY_ACTS_MAX_ROWS) {
    throw new ValidationError('rows', 'Слишком много строк в книге Excel');
  }
  const rows: LegacyActsSheetCell[][] = [];
  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    rows.push(
      Array.from({ length: LEGACY_ACTS_REQUIRED_HEADERS.length }, (_, index) => {
        const cell = row.getCell(index + 1);
        return {
          value: cell.value,
          hyperlink: typeof cell.hyperlink === 'string' ? cell.hyperlink : null,
        };
      }),
    );
  }
  return {
    parse: parseLegacyActsSheetMatrix(rows),
    sha256,
    fileName: basename(resolved),
    filePath: resolved,
    sizeBytes: stats.size,
    sheetNames,
  };
}
