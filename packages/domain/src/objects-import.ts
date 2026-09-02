import { createHash } from 'node:crypto';
import { ValidationError } from './errors';
import { foldKey, normalizeUnicode } from './text';

export const OBJECTS_SHEET_NAME = 'Объекты';
export const OBJECTS_SOURCE_SYSTEM = 'SGR_OBJECTS_XLSX';
export const OBJECTS_IMPORT_KEY_VERSION = 'v1';

export const OBJECTS_REQUIRED_HEADERS = [
  'Объекты',
  'Адреса',
  'Дата приёмки в эксплуатацию',
  'Дата завершения гарантийного срока',
  'Ответственный инженер',
] as const;

export type ObjectsImportAction = 'create' | 'update' | 'unchanged' | 'skip_duplicate' | 'conflict';

export interface ObjectsSheetCell {
  value: unknown;
}

export interface ParsedObjectImportRow {
  sourceRow: number;
  name: string;
  address: string | null;
  commissionedAt: string | null;
  warrantyEndsAt: string | null;
  sourceResponsibleEngineerName: string | null;
  sourceImportKey: string;
}

export interface ObjectsWorkbookParseResult {
  sheetName: string;
  headers: string[];
  sourceRows: number;
  blankRows: number[];
  duplicates: Array<{ keptSourceRow: number; skippedSourceRow: number; name: string }>;
  uniqueRows: ParsedObjectImportRow[];
}

export interface ExistingPropertyObjectSnapshot {
  id: string;
  name: string;
  address: string | null;
  commissionedAt: string | null;
  warrantyEndsAt: string | null;
  sortOrder: number;
  sourceResponsibleEngineerName: string | null;
  sourceSystem: string | null;
  sourceRow: number | null;
  sourceImportKey: string | null;
}

export interface ObjectsImportPlanItem {
  action: ObjectsImportAction;
  reason?: string;
  sourceRow?: number;
  existingId?: string;
  row?: ParsedObjectImportRow;
}

export interface ObjectsImportPlan {
  existingCount: number;
  matched: number;
  create: number;
  update: number;
  unchanged: number;
  outsideExcel: number;
  duplicatesSkipped: number;
  conflicts: ObjectsImportPlanItem[];
  items: ObjectsImportPlanItem[];
}

export type ResponsibleEngineerLinkStatus = 'EMPTY' | 'LINKED' | 'UNRESOLVED' | 'AMBIGUOUS';

export interface ResponsibleEngineerCandidate {
  fullName: string;
  role: string;
  status: string;
}

export function assertObjectsSheetName(sheetNames: readonly string[]): void {
  if (!sheetNames.includes(OBJECTS_SHEET_NAME)) {
    throw new ValidationError('sheet', `Лист «${OBJECTS_SHEET_NAME}» не найден`);
  }
}

export function normalizeHeaderCell(value: unknown): string {
  return normalizeOptionalImportText(value) ?? '';
}

export function assertObjectsHeaders(headers: readonly string[]): void {
  if (headers.length < OBJECTS_REQUIRED_HEADERS.length) {
    throw new ValidationError('headers', 'Не хватает обязательных колонок');
  }
  for (const [index, expected] of OBJECTS_REQUIRED_HEADERS.entries()) {
    if (headers[index] !== expected) {
      throw new ValidationError(
        'headers',
        `Ожидался заголовок «${expected}», получено «${headers[index] ?? ''}»`,
      );
    }
  }
}

export function normalizeOptionalImportText(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const text = normalizeUnicode(String(value)).trim();
    return text.length === 0 ? null : text;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const text = normalizeUnicode(value).trim();
  return text.length === 0 ? null : text;
}

export function excelSerialToIsoDate(serial: number): string {
  if (!Number.isFinite(serial) || serial < 1 || serial >= 1000000) {
    throw new ValidationError('date', 'Некорректный серийный номер даты Excel');
  }
  const whole = Math.floor(serial);
  const utc = Date.UTC(1899, 11, 30) + whole * 86_400_000;
  return new Date(utc).toISOString().slice(0, 10);
}

export function isoDateFromJsDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseImportedExcelDate(value: unknown): string | null {
  const cached = cachedExcelValue(value);
  if (cached === undefined || cached === null || cached === '') {
    return null;
  }
  if (cached instanceof Date) {
    if (Number.isNaN(cached.getTime())) {
      throw new ValidationError('date', 'Некорректная дата Excel');
    }
    return isoDateFromJsDate(cached);
  }
  if (typeof cached === 'number') {
    return excelSerialToIsoDate(cached);
  }
  if (typeof cached === 'string') {
    const trimmed = cached.trim();
    if (!trimmed) {
      return null;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
    throw new ValidationError('date', 'Ожидается дата, а не произвольный текст');
  }
  throw new ValidationError('date', 'Некорректный тип даты Excel');
}

export function cachedExcelValue(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    const record = value as {
      formula?: unknown;
      sharedFormula?: unknown;
      result?: unknown;
      richText?: Array<{ text?: string }>;
      text?: unknown;
      hyperlink?: unknown;
    };
    if ('formula' in record || 'sharedFormula' in record) {
      return record.result ?? null;
    }
    if (Array.isArray(record.richText)) {
      return record.richText.map((part) => part.text ?? '').join('');
    }
    if ('text' in record && ('hyperlink' in record || typeof record.text === 'string')) {
      return record.text ?? null;
    }
  }
  return value;
}

export function buildSourceImportKey(input: {
  name: string;
  address: string | null;
  commissionedAt: string | null;
  warrantyEndsAt: string | null;
  sourceResponsibleEngineerName: string | null;
}): string {
  const payload = [
    OBJECTS_SOURCE_SYSTEM,
    OBJECTS_IMPORT_KEY_VERSION,
    input.name,
    input.address ?? '',
    input.commissionedAt ?? '',
    input.warrantyEndsAt ?? '',
    input.sourceResponsibleEngineerName ?? '',
  ].join('\u001f');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function parseObjectsSheetMatrix(rows: unknown[][]): ObjectsWorkbookParseResult {
  if (rows.length === 0) {
    throw new ValidationError('headers', 'Пустой лист «Объекты»');
  }
  const headerRow = rows[0] ?? [];
  const headers = Array.from({ length: OBJECTS_REQUIRED_HEADERS.length }, (_, index) =>
    normalizeHeaderCell(cachedExcelValue(headerRow[index])),
  );
  assertObjectsHeaders(headers);

  const uniqueRows: ParsedObjectImportRow[] = [];
  const seenKeys = new Map<string, number>();
  const duplicates: ObjectsWorkbookParseResult['duplicates'] = [];
  const blankRows: number[] = [];
  let sourceRows = 0;

  for (let index = 1; index < rows.length; index += 1) {
    const excelRow = index + 1;
    const cells = rows[index] ?? [];
    const name = normalizeOptionalImportText(cachedExcelValue(cells[0]));
    const address = normalizeOptionalImportText(cachedExcelValue(cells[1]));
    const engineer = normalizeOptionalImportText(cachedExcelValue(cells[4]));
    const commissionedAt = parseImportedExcelDate(cells[2]);
    const warrantyEndsAt = parseImportedExcelDate(cells[3]);
    if (!name && !address && !engineer && !commissionedAt && !warrantyEndsAt) {
      blankRows.push(excelRow);
      continue;
    }
    if (!name) {
      throw new ValidationError('name', `Строка ${excelRow}: пустое название объекта`);
    }
    sourceRows += 1;
    const parsed: ParsedObjectImportRow = {
      sourceRow: excelRow,
      name,
      address,
      commissionedAt,
      warrantyEndsAt,
      sourceResponsibleEngineerName: engineer,
      sourceImportKey: '',
    };
    parsed.sourceImportKey = buildSourceImportKey(parsed);
    const keptRow = seenKeys.get(parsed.sourceImportKey);
    if (keptRow) {
      duplicates.push({
        keptSourceRow: keptRow,
        skippedSourceRow: excelRow,
        name: parsed.name,
      });
      continue;
    }
    seenKeys.set(parsed.sourceImportKey, excelRow);
    uniqueRows.push(parsed);
  }

  return {
    sheetName: OBJECTS_SHEET_NAME,
    headers,
    sourceRows,
    blankRows,
    duplicates,
    uniqueRows,
  };
}

export function planPropertyObjectsImport(
  parsed: ObjectsWorkbookParseResult,
  existing: readonly ExistingPropertyObjectSnapshot[],
): ObjectsImportPlan {
  const items: ObjectsImportPlanItem[] = parsed.duplicates.map((duplicate) => ({
    action: 'skip_duplicate',
    sourceRow: duplicate.skippedSourceRow,
    reason: `Полный дубль строки ${duplicate.keptSourceRow}`,
  }));

  for (const row of parsed.uniqueRows) {
    items.push(decideExistingMatch(row, existing));
  }

  const conflicts = items.filter((item) => item.action === 'conflict');
  const matchedItems = items.filter(
    (item) => item.action === 'update' || item.action === 'unchanged',
  );
  const usedIds = new Set(items.flatMap((item) => (item.existingId ? [item.existingId] : [])));

  return {
    existingCount: existing.length,
    matched: matchedItems.length,
    create: items.filter((item) => item.action === 'create').length,
    update: items.filter((item) => item.action === 'update').length,
    unchanged: items.filter((item) => item.action === 'unchanged').length,
    outsideExcel: existing.filter((row) => !usedIds.has(row.id)).length,
    duplicatesSkipped: parsed.duplicates.length,
    conflicts,
    items,
  };
}

function decideExistingMatch(
  row: ParsedObjectImportRow,
  existing: readonly ExistingPropertyObjectSnapshot[],
): ObjectsImportPlanItem {
  const byKey = existing.filter(
    (item) =>
      item.sourceSystem === OBJECTS_SOURCE_SYSTEM && item.sourceImportKey === row.sourceImportKey,
  );
  if (byKey.length > 1) {
    return {
      action: 'conflict',
      sourceRow: row.sourceRow,
      row,
      reason: 'Неоднозначное совпадение по ключу импорта',
    };
  }
  if (byKey.length === 1) {
    return snapshotAction(row, byKey[0]!);
  }

  const byName = existing.filter((item) => foldKey(item.name) === foldKey(row.name));
  if (byName.length === 0) {
    return { action: 'create', sourceRow: row.sourceRow, row };
  }
  if (byName.length > 1) {
    return {
      action: 'conflict',
      sourceRow: row.sourceRow,
      row,
      reason: 'Неоднозначное совпадение названия',
    };
  }
  const candidate = byName[0]!;
  if (
    candidate.sourceImportKey &&
    candidate.sourceSystem === OBJECTS_SOURCE_SYSTEM &&
    candidate.sourceImportKey !== row.sourceImportKey
  ) {
    return {
      action: 'conflict',
      sourceRow: row.sourceRow,
      existingId: candidate.id,
      row,
      reason: 'Существующий объект уже связан с другим ключом импорта',
    };
  }
  if (candidate.address && row.address && foldKey(candidate.address) !== foldKey(row.address)) {
    return {
      action: 'conflict',
      sourceRow: row.sourceRow,
      existingId: candidate.id,
      row,
      reason: 'Одно название с разными адресами',
    };
  }
  return snapshotAction(row, candidate);
}

function snapshotAction(
  row: ParsedObjectImportRow,
  existing: ExistingPropertyObjectSnapshot,
): ObjectsImportPlanItem {
  const same =
    existing.name === row.name &&
    (existing.address ?? null) === row.address &&
    existing.commissionedAt === row.commissionedAt &&
    existing.warrantyEndsAt === row.warrantyEndsAt &&
    (existing.sourceResponsibleEngineerName ?? null) === row.sourceResponsibleEngineerName &&
    existing.sortOrder === row.sourceRow &&
    existing.sourceSystem === OBJECTS_SOURCE_SYSTEM &&
    existing.sourceRow === row.sourceRow &&
    existing.sourceImportKey === row.sourceImportKey;
  return {
    action: same ? 'unchanged' : 'update',
    sourceRow: row.sourceRow,
    existingId: existing.id,
    row,
  };
}

export function classifyResponsibleEngineerName(
  sourceName: string | null,
  candidates: readonly ResponsibleEngineerCandidate[],
): ResponsibleEngineerLinkStatus {
  if (!sourceName) {
    return 'EMPTY';
  }
  const matches = candidates.filter(
    (item) =>
      item.role === 'RESPONSIBLE_ENGINEER' &&
      item.status === 'ACTIVE' &&
      foldKey(item.fullName) === foldKey(sourceName),
  );
  if (matches.length === 1) {
    return 'LINKED';
  }
  if (matches.length > 1) {
    return 'AMBIGUOUS';
  }
  return 'UNRESOLVED';
}
