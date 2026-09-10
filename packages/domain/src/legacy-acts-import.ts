import { createHash } from 'node:crypto';
import type { ActFormCode, ActStatus, OrganizationRole } from '@sgr-registry/contracts';
import { ACTS_REGISTRY_SHEET_NAME } from './directories-import';
import { classifyEngineerMatch, type EngineerMatchCandidate } from './engineer-name';
import { ValidationError } from './errors';
import { isoDateFromJsDate, parseImportedExcelDate } from './objects-import';
import { foldMatchKey, normalizeUnicode } from './text';

export { ACTS_REGISTRY_SHEET_NAME };

export const LEGACY_ACT_SOURCE_SYSTEM = 'LEGACY_DEFECT_ACT_REGISTRY';
export const LEGACY_ACT_DOCUMENT_HOST = 'bitrix.bir.by';
export const LEGACY_ACTS_IMPORT_LOCK_KEY1 = 20260904;
export const LEGACY_ACTS_IMPORT_LOCK_KEY2 = 1;
export const LEGACY_ACTS_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const LEGACY_ACTS_MAX_SHEETS = 8;
export const LEGACY_ACTS_MAX_ROWS = 5_000;
export const LEGACY_ACTS_HEADER_ROW = 2;
export const LEGACY_ACTS_DATA_START_ROW = 4;
export const KNOWN_LEGACY_REGISTRY_SHA256 =
  '4e85fa1607c275caa1211c7b6062c75e78eaaafd7858f1586ee6842b9f935b47';

export const LEGACY_ACTS_REQUIRED_HEADERS = [
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
] as const;

const UNSET_DEADLINE_KEYS = new Set(['', '-', 'не установлен']);
const PLACEHOLDER_ORG_KEYS = new Set(['', '-', 'не установлена']);
const PLACEHOLDER_LOCATION_KEYS = new Set(['', '-']);

export type LegacyActsImportAction = 'create' | 'unchanged' | 'conflict';

export interface LegacyActsSheetCell {
  value: unknown;
  hyperlink?: string | null;
}

export interface ParsedLegacyActSourceRow {
  sourceRow: number;
  actNumberRaw: string | null;
  formLabelRaw: string;
  formCode: ActFormCode;
  statusRaw: string | null;
  status: ActStatus;
  objectNameRaw: string;
  locationRaw: string | null;
  location: string | null;
  defectTypeNameRaw: string;
  customerNameRaw: string;
  liableOrganizationRaw: string | null;
  liableOrganizationName: string | null;
  engineerNameRaw: string | null;
  issuedOn: string;
  deadlineRaw: string | null;
  plannedDeadline: string | null;
  documentUrlRaw: string | null;
  documentUrl: string;
}

export interface GroupedLegacyDefect {
  sourceImportKey: string;
  sourceRows: number[];
  location: string | null;
  locationRaw: string | null;
  defectTypeNameRaw: string;
  deadlineRaw: string | null;
  plannedDeadline: string | null;
  liableOrganizationNames: string[];
  engineerNames: string[];
}

export interface GroupedLegacyAct {
  sourceImportKey: string;
  sourceRows: number[];
  documentUrl: string;
  actNumberRaw: string | null;
  formCode: ActFormCode;
  formLabelRaw: string;
  status: ActStatus;
  statusRaw: string | null;
  objectNameRaw: string;
  customerNameRaw: string;
  issuedOn: string;
  defects: GroupedLegacyDefect[];
}

export interface LegacyActsWorkbookParseResult {
  sheetName: string;
  headers: string[];
  sourceRows: number;
  blankRows: number[];
  brokenAddressFormulas: number;
  uniqueDocumentUrls: number;
  repeatedUrlGroups: number;
  maxRowsPerUrl: number;
  groupedActs: GroupedLegacyAct[];
  groupingConflicts: Array<{ documentUrl: string; reason: string; sourceRows: number[] }>;
  invalidRows: Array<{ sourceRow: number; field: string; message: string }>;
}

export interface CatalogMatch<T> {
  result: 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' | 'CREATE' | 'PLACEHOLDER';
  matches: T[];
  sourceName: string;
}

export interface LegacyActsCatalogObject {
  id: string;
  name: string;
  address: string | null;
}

export interface LegacyActsCatalogOrganization {
  id: string;
  officialName: string;
  unp: string | null;
  roles: readonly OrganizationRole[];
}

export interface LegacyActsCatalogDefectType {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number;
}

export interface ExistingLegacyActSnapshot {
  id: string;
  sourceSystem: string | null;
  sourceImportKey: string | null;
  formCode: ActFormCode;
  issuedOn: string;
  objectId: string;
  customerOrganizationId: string;
  status: ActStatus;
  officialNumber: string | null;
  sourceActNumberRaw: string | null;
  sourceStatusRaw: string | null;
  sourceExternalUrl: string | null;
  sourceRows: number[];
}

export interface ExistingLegacyDefectSnapshot {
  id: string;
  actId: string;
  sourceSystem: string | null;
  sourceImportKey: string | null;
  location: string | null;
  defectTypeName: string;
  plannedDeadline: string | null;
  sourceDeadlineRaw: string | null;
  liableOrganizationIds: string[];
  engineerIds: string[];
  unresolvedEngineerKeys: string[];
}

export interface LegacyActsCatalog {
  objects: LegacyActsCatalogObject[];
  organizations: LegacyActsCatalogOrganization[];
  engineers: EngineerMatchCandidate[];
  defectTypes: LegacyActsCatalogDefectType[];
  existingActs: ExistingLegacyActSnapshot[];
  existingDefects: ExistingLegacyDefectSnapshot[];
}

export interface FieldDiff {
  field: string;
  existing: string | null;
  incoming: string | null;
}

export interface LegacyActsPlanAct {
  action: LegacyActsImportAction;
  sourceImportKey: string;
  group: GroupedLegacyAct;
  existingId?: string;
  object?: LegacyActsCatalogObject;
  customer?: LegacyActsCatalogOrganization;
  createCustomerName?: string;
  diffs?: FieldDiff[];
  defects: LegacyActsPlanDefect[];
}

export interface LegacyActsPlanDefect {
  action: LegacyActsImportAction;
  sourceImportKey: string;
  group: GroupedLegacyDefect;
  existingId?: string;
  defectType?: LegacyActsCatalogDefectType;
  createDefectTypeName?: string;
  liableOrganizations: Array<
    | { action: 'link'; organization: LegacyActsCatalogOrganization }
    | { action: 'create'; name: string }
  >;
  engineers: Array<
    | { result: 'MATCHED'; name: string; userId: string; fullName: string }
    | { result: 'UNMATCHED'; name: string; userId: null; fullName: null }
  >;
  diffs?: FieldDiff[];
}

export interface LegacyActsImportPlan {
  actsToCreate: number;
  actsUnchanged: number;
  defectsToCreate: number;
  defectsUnchanged: number;
  liableLinksToCreate: number;
  engineerLinksToCreate: number;
  unresolvedEngineerLinksToCreate: number;
  customersToCreate: string[];
  liableOrganizationsToCreate: string[];
  defectTypesToCreate: string[];
  objectMatches: CatalogMatch<LegacyActsCatalogObject>[];
  customerMatches: CatalogMatch<LegacyActsCatalogOrganization>[];
  liableMatches: CatalogMatch<LegacyActsCatalogOrganization>[];
  engineerMatches: CatalogMatch<EngineerMatchCandidate>[];
  defectTypeMatches: CatalogMatch<LegacyActsCatalogDefectType>[];
  blockingIssues: string[];
  warnings: string[];
  payloadConflicts: Array<{ sourceImportKey: string; diffs: FieldDiff[] }>;
  groupingConflicts: LegacyActsWorkbookParseResult['groupingConflicts'];
  invalidRows: LegacyActsWorkbookParseResult['invalidRows'];
  acts: LegacyActsPlanAct[];
}

export function normalizeActsHeader(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return normalizeUnicode(value).replace(/\s+/g, ' ').trim();
}

export function assertLegacyActsSheetName(sheetNames: readonly string[]): void {
  if (!sheetNames.includes(ACTS_REGISTRY_SHEET_NAME)) {
    throw new ValidationError('sheet', `Лист «${ACTS_REGISTRY_SHEET_NAME}» не найден`);
  }
}

export function assertLegacyActsHeaders(headers: readonly string[]): void {
  if (headers.length < LEGACY_ACTS_REQUIRED_HEADERS.length) {
    throw new ValidationError('headers', 'Не хватает обязательных колонок');
  }
  for (const [index, expected] of LEGACY_ACTS_REQUIRED_HEADERS.entries()) {
    if (headers[index] !== expected) {
      throw new ValidationError(
        'headers',
        `Ожидался заголовок «${expected}», получено «${headers[index] ?? ''}»`,
      );
    }
  }
}

export function canonicalizeLegacyActDocumentUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== LEGACY_ACT_DOCUMENT_HOST) {
    return null;
  }
  if (parsed.port && parsed.port !== '443') {
    return null;
  }
  return `https://${LEGACY_ACT_DOCUMENT_HOST}${parsed.pathname}${parsed.search}`;
}

export function isLegacyActDocumentHref(value: string | null | undefined): value is string {
  return Boolean(value && canonicalizeLegacyActDocumentUrl(value) === value);
}

export function buildLegacyActSourceImportKey(canonicalUrl: string): string {
  return `${LEGACY_ACT_SOURCE_SYSTEM}:${canonicalUrl}`;
}

export function buildLegacyDefectSourceImportKey(input: {
  actSourceImportKey: string;
  location: string | null;
  defectTypeName: string;
  deadlineRaw: string | null;
}): string {
  return [
    input.actSourceImportKey,
    foldMatchKey(input.location ?? ''),
    foldMatchKey(input.defectTypeName),
    foldMatchKey(input.deadlineRaw ?? ''),
  ].join('\u001f');
}

export function legacyDefectTypeCode(name: string, existingCodes: readonly string[]): string {
  const digest = createHash('sha256')
    .update(foldMatchKey(name), 'utf8')
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  const taken = new Set(existingCodes.map((item) => foldMatchKey(item)));
  const candidates = [`DT_LEG_${digest}`, `DT_LEG_${digest}2`, `DT_LEG_${digest}X`];
  for (const candidate of candidates) {
    if (!taken.has(foldMatchKey(candidate))) {
      return candidate.slice(0, 40);
    }
  }
  return `DT_LEG_${digest}Z`.slice(0, 40);
}

export function parseLegacyActForm(value: string): ActFormCode | null {
  const key = foldMatchKey(value).replaceAll(' ', '');
  if (key === 'с-23' || key === 'с23' || key === 's23' || key === 's-23') {
    return 'S23';
  }
  if (key === 'с-1' || key === 'с1' || key === 's1' || key === 's-1') {
    return 'S1';
  }
  return null;
}

export function parseLegacyActStatus(value: string | null): ActStatus | null {
  if (!value) {
    return 'IMPORTED_UNSPECIFIED';
  }
  const key = foldMatchKey(value);
  if (key === 'в работе') {
    return 'IN_PROGRESS';
  }
  if (UNSET_DEADLINE_KEYS.has(key)) {
    return 'IMPORTED_UNSPECIFIED';
  }
  return null;
}

export function isPlaceholderOrganizationName(value: string | null): boolean {
  return PLACEHOLDER_ORG_KEYS.has(foldMatchKey(value ?? ''));
}

export function isPlaceholderLocation(value: string | null): boolean {
  return PLACEHOLDER_LOCATION_KEYS.has(foldMatchKey(value ?? ''));
}

export function isUnsetDeadlineText(value: string | null): boolean {
  return UNSET_DEADLINE_KEYS.has(foldMatchKey(value ?? ''));
}

export function slaEligibleForImportedAct(input: {
  status: ActStatus;
  startedAt: Date | string | null;
}): boolean {
  if (input.status === 'IMPORTED_UNSPECIFIED' || input.status === 'CANCELLED') {
    return false;
  }
  return input.startedAt != null;
}

export function isStartableActStatus(status: ActStatus): boolean {
  return status === 'NEW' || status === 'IMPORTED_UNSPECIFIED';
}

function cellText(cell: LegacyActsSheetCell | unknown): string | null {
  const record = isSheetCell(cell) ? cell : { value: cell };
  const value = record.value;
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const text = normalizeUnicode(String(value)).trim();
    return text.length === 0 ? null : text;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return isoDateFromJsDate(value);
  }
  if (typeof value === 'string') {
    const text = normalizeUnicode(value).trim();
    return text.length === 0 ? null : text;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const object = value as {
      formula?: unknown;
      sharedFormula?: unknown;
      result?: unknown;
      text?: unknown;
      richText?: Array<{ text?: string }>;
      hyperlink?: unknown;
    };
    if ('formula' in object || 'sharedFormula' in object) {
      return typeof object.result === 'string'
        ? normalizeUnicode(object.result).trim() || null
        : null;
    }
    if (Array.isArray(object.richText)) {
      const text = normalizeUnicode(object.richText.map((part) => part.text ?? '').join('')).trim();
      return text.length === 0 ? null : text;
    }
    if (typeof object.text === 'string') {
      const text = normalizeUnicode(object.text).trim();
      return text.length === 0 ? null : text;
    }
  }
  return null;
}

function isSheetCell(value: unknown): value is LegacyActsSheetCell {
  return Boolean(value && typeof value === 'object' && 'value' in value && !Array.isArray(value));
}

function extractUrl(cell: LegacyActsSheetCell | unknown): string | null {
  const record = isSheetCell(cell) ? cell : { value: cell };
  if (typeof record.hyperlink === 'string' && record.hyperlink.trim()) {
    return record.hyperlink.trim();
  }
  const value = record.value;
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    const object = value as { hyperlink?: unknown; text?: unknown; formula?: unknown };
    if ('formula' in object) {
      return null;
    }
    if (typeof object.hyperlink === 'string' && object.hyperlink.trim()) {
      return object.hyperlink.trim();
    }
  }
  const text = cellText(record);
  return text;
}

function deadlineOf(cell: LegacyActsSheetCell | unknown): {
  calendarDate: string | null;
  raw: string | null;
} {
  const record = isSheetCell(cell) ? cell : { value: cell };
  const raw = cellText(record);
  if (!raw || isUnsetDeadlineText(raw)) {
    return { calendarDate: null, raw: raw };
  }
  try {
    const calendarDate = parseImportedExcelDate(record.value);
    if (calendarDate) {
      return { calendarDate, raw: calendarDate };
    }
  } catch {
    return { calendarDate: null, raw };
  }
  return { calendarDate: null, raw };
}

function uniquePreserve(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = foldMatchKey(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function parseLegacyActsSheetMatrix(
  rows: Array<Array<LegacyActsSheetCell | unknown>>,
): LegacyActsWorkbookParseResult {
  if (rows.length < LEGACY_ACTS_HEADER_ROW) {
    throw new ValidationError('headers', 'Не найдены заголовки реестра актов');
  }
  const headerRow = rows[LEGACY_ACTS_HEADER_ROW - 1] ?? [];
  const headers = Array.from({ length: LEGACY_ACTS_REQUIRED_HEADERS.length }, (_, index) =>
    normalizeActsHeader(isSheetCell(headerRow[index]) ? headerRow[index]?.value : headerRow[index]),
  );
  assertLegacyActsHeaders(headers);

  const blankRows: number[] = [];
  const invalidRows: Array<{ sourceRow: number; field: string; message: string }> = [];
  const parsedRows: ParsedLegacyActSourceRow[] = [];
  let brokenAddressFormulas = 0;

  if (rows.length > LEGACY_ACTS_MAX_ROWS) {
    throw new ValidationError('rows', 'Слишком много строк в книге Excel');
  }

  const unexpectedTitleData = rows[LEGACY_ACTS_HEADER_ROW]?.some((cell) => cellText(cell));
  if (unexpectedTitleData) {
    invalidRows.push({
      sourceRow: 3,
      field: 'sheet',
      message: 'Строка 3 должна быть пустой',
    });
  }

  for (let index = LEGACY_ACTS_DATA_START_ROW - 1; index < rows.length; index += 1) {
    const sourceRow = index + 1;
    const row = rows[index] ?? [];
    const occupied = Array.from({ length: LEGACY_ACTS_REQUIRED_HEADERS.length }, (_, column) =>
      cellText(row[column]),
    ).some(Boolean);
    if (!occupied) {
      blankRows.push(sourceRow);
      continue;
    }
    const addressCell = isSheetCell(row[4]) ? row[4].value : row[4];
    if (
      addressCell &&
      typeof addressCell === 'object' &&
      !Array.isArray(addressCell) &&
      'formula' in addressCell
    ) {
      brokenAddressFormulas += 1;
    }
    const formLabelRaw = cellText(row[1]);
    const formCode = formLabelRaw ? parseLegacyActForm(formLabelRaw) : null;
    const statusRaw = cellText(row[2]);
    const status = parseLegacyActStatus(statusRaw);
    const objectNameRaw = cellText(row[3]);
    const locationRaw = cellText(row[5]);
    const defectTypeNameRaw = cellText(row[6]);
    const customerNameRaw = cellText(row[7]);
    const liableRaw = cellText(row[8]);
    const engineerNameRaw = cellText(row[9]);
    const issuedRaw = row[10];
    const deadline = deadlineOf(row[11]);
    const documentUrlRaw = extractUrl(row[21]);
    const canonicalUrl = documentUrlRaw ? canonicalizeLegacyActDocumentUrl(documentUrlRaw) : null;

    if (!formCode || !formLabelRaw) {
      invalidRows.push({ sourceRow, field: 'formCode', message: 'Некорректная форма акта' });
      continue;
    }
    if (!status) {
      invalidRows.push({ sourceRow, field: 'status', message: 'Некорректный статус' });
      continue;
    }
    if (!objectNameRaw) {
      invalidRows.push({ sourceRow, field: 'object', message: 'Не указан объект' });
      continue;
    }
    if (!defectTypeNameRaw) {
      invalidRows.push({ sourceRow, field: 'defectType', message: 'Не указан вид дефекта' });
      continue;
    }
    if (!customerNameRaw) {
      invalidRows.push({ sourceRow, field: 'customer', message: 'Не указан заказчик' });
      continue;
    }
    let issuedOn: string | null;
    try {
      issuedOn = parseImportedExcelDate(isSheetCell(issuedRaw) ? issuedRaw.value : issuedRaw);
    } catch {
      issuedOn = null;
    }
    if (!issuedOn) {
      invalidRows.push({ sourceRow, field: 'issuedOn', message: 'Некорректная дата составления' });
      continue;
    }
    if (!canonicalUrl) {
      invalidRows.push({
        sourceRow,
        field: 'documentUrl',
        message: 'Ссылка должна быть https://bitrix.bir.by/...',
      });
      continue;
    }

    parsedRows.push({
      sourceRow,
      actNumberRaw: cellText(row[0]),
      formLabelRaw,
      formCode,
      statusRaw,
      status,
      objectNameRaw,
      locationRaw,
      location: isPlaceholderLocation(locationRaw) ? null : locationRaw,
      defectTypeNameRaw,
      customerNameRaw,
      liableOrganizationRaw: liableRaw,
      liableOrganizationName: isPlaceholderOrganizationName(liableRaw) ? null : liableRaw,
      engineerNameRaw,
      issuedOn,
      deadlineRaw: deadline.raw,
      plannedDeadline: deadline.calendarDate,
      documentUrlRaw,
      documentUrl: canonicalUrl,
    });
  }

  const byUrl = new Map<string, ParsedLegacyActSourceRow[]>();
  for (const row of parsedRows) {
    const current = byUrl.get(row.documentUrl) ?? [];
    current.push(row);
    byUrl.set(row.documentUrl, current);
  }

  const groupingConflicts: LegacyActsWorkbookParseResult['groupingConflicts'] = [];
  const groupedActs: GroupedLegacyAct[] = [];
  let repeatedUrlGroups = 0;
  let maxRowsPerUrl = 1;

  for (const [documentUrl, groupRows] of byUrl) {
    if (groupRows.length > 1) {
      repeatedUrlGroups += 1;
    }
    maxRowsPerUrl = Math.max(maxRowsPerUrl, groupRows.length);
    const conflict = groupingConflictOf(groupRows);
    if (conflict) {
      groupingConflicts.push({
        documentUrl,
        reason: conflict,
        sourceRows: groupRows.map((row) => row.sourceRow),
      });
      continue;
    }
    const first = groupRows[0]!;
    const defectsByKey = new Map<string, GroupedLegacyDefect>();
    for (const row of groupRows) {
      const sourceImportKey = buildLegacyDefectSourceImportKey({
        actSourceImportKey: buildLegacyActSourceImportKey(documentUrl),
        location: row.location,
        defectTypeName: row.defectTypeNameRaw,
        deadlineRaw: row.deadlineRaw,
      });
      const current = defectsByKey.get(sourceImportKey);
      if (!current) {
        defectsByKey.set(sourceImportKey, {
          sourceImportKey,
          sourceRows: [row.sourceRow],
          location: row.location,
          locationRaw: row.locationRaw,
          defectTypeNameRaw: row.defectTypeNameRaw,
          deadlineRaw: row.deadlineRaw,
          plannedDeadline: row.plannedDeadline,
          liableOrganizationNames: row.liableOrganizationName ? [row.liableOrganizationName] : [],
          engineerNames: row.engineerNameRaw ? [row.engineerNameRaw] : [],
        });
        continue;
      }
      current.sourceRows.push(row.sourceRow);
      if (row.liableOrganizationName) {
        current.liableOrganizationNames = uniquePreserve([
          ...current.liableOrganizationNames,
          row.liableOrganizationName,
        ]);
      }
      if (row.engineerNameRaw) {
        current.engineerNames = uniquePreserve([...current.engineerNames, row.engineerNameRaw]);
      }
    }
    groupedActs.push({
      sourceImportKey: buildLegacyActSourceImportKey(documentUrl),
      sourceRows: groupRows.map((row) => row.sourceRow),
      documentUrl,
      actNumberRaw: first.actNumberRaw,
      formCode: first.formCode,
      formLabelRaw: first.formLabelRaw,
      status: first.status,
      statusRaw: first.statusRaw,
      objectNameRaw: first.objectNameRaw,
      customerNameRaw: first.customerNameRaw,
      issuedOn: first.issuedOn,
      defects: [...defectsByKey.values()],
    });
  }

  return {
    sheetName: ACTS_REGISTRY_SHEET_NAME,
    headers,
    sourceRows: parsedRows.length,
    blankRows,
    brokenAddressFormulas,
    uniqueDocumentUrls: byUrl.size,
    repeatedUrlGroups,
    maxRowsPerUrl,
    groupedActs,
    groupingConflicts,
    invalidRows,
  };
}

function groupingConflictOf(rows: readonly ParsedLegacyActSourceRow[]): string | null {
  const first = rows[0];
  if (!first) {
    return 'Пустая группа';
  }
  for (const row of rows) {
    if (row.formCode !== first.formCode) {
      return 'Конфликт формы акта внутри одной ссылки';
    }
    if (foldMatchKey(row.objectNameRaw) !== foldMatchKey(first.objectNameRaw)) {
      return 'Конфликт объекта внутри одной ссылки';
    }
    if (foldMatchKey(row.customerNameRaw) !== foldMatchKey(first.customerNameRaw)) {
      return 'Конфликт заказчика внутри одной ссылки';
    }
    if (row.issuedOn !== first.issuedOn) {
      return 'Конфликт даты составления внутри одной ссылки';
    }
    if (
      row.actNumberRaw &&
      first.actNumberRaw &&
      foldMatchKey(row.actNumberRaw) !== foldMatchKey(first.actNumberRaw)
    ) {
      return 'Конфликт номера акта внутри одной ссылки';
    }
    if ((row.statusRaw ?? '') !== (first.statusRaw ?? '')) {
      return 'Конфликт статуса внутри одной ссылки';
    }
  }
  return null;
}

function matchByName<T>(
  sourceName: string,
  items: readonly T[],
  nameOf: (item: T) => string,
): { result: 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS'; matches: T[] } {
  const key = foldMatchKey(sourceName);
  const matches = items.filter((item) => foldMatchKey(nameOf(item)) === key);
  if (matches.length === 1) {
    return { result: 'MATCHED', matches };
  }
  if (matches.length > 1) {
    return { result: 'AMBIGUOUS', matches };
  }
  return { result: 'UNMATCHED', matches: [] };
}

function matchOrganization(
  sourceName: string,
  items: readonly LegacyActsCatalogOrganization[],
): { result: 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS'; matches: LegacyActsCatalogOrganization[] } {
  const key = foldMatchKey(sourceName);
  const unique = new Map<string, LegacyActsCatalogOrganization>();
  for (const item of items) {
    if (foldMatchKey(item.officialName) === key || (item.unp && foldMatchKey(item.unp) === key)) {
      unique.set(item.id, item);
    }
  }
  const matches = [...unique.values()];
  if (matches.length === 1) {
    return { result: 'MATCHED', matches };
  }
  if (matches.length > 1) {
    return { result: 'AMBIGUOUS', matches };
  }
  return { result: 'UNMATCHED', matches: [] };
}

export function planLegacyActsImport(
  parsed: LegacyActsWorkbookParseResult,
  catalog: LegacyActsCatalog,
): LegacyActsImportPlan {
  const objectMatches: CatalogMatch<LegacyActsCatalogObject>[] = [];
  const customerMatches: CatalogMatch<LegacyActsCatalogOrganization>[] = [];
  const liableMatches: CatalogMatch<LegacyActsCatalogOrganization>[] = [];
  const engineerMatches: CatalogMatch<EngineerMatchCandidate>[] = [];
  const defectTypeMatches: CatalogMatch<LegacyActsCatalogDefectType>[] = [];
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  const payloadConflicts: Array<{ sourceImportKey: string; diffs: FieldDiff[] }> = [];
  const customersToCreate: string[] = [];
  const liableOrganizationsToCreate: string[] = [];
  const defectTypesToCreate: string[] = [];
  const acts: LegacyActsPlanAct[] = [];

  const seenObject = new Set<string>();
  const seenCustomer = new Set<string>();
  const seenLiable = new Set<string>();
  const seenEngineer = new Set<string>();
  const seenDefectType = new Set<string>();

  for (const issue of parsed.invalidRows) {
    blockingIssues.push(`Строка ${issue.sourceRow}: ${issue.message}`);
  }
  for (const conflict of parsed.groupingConflicts) {
    blockingIssues.push(`${conflict.reason} (${conflict.documentUrl})`);
  }

  const existingActs = new Map(
    catalog.existingActs
      .filter((item) => item.sourceSystem === LEGACY_ACT_SOURCE_SYSTEM && item.sourceImportKey)
      .map((item) => [item.sourceImportKey!, item]),
  );
  const existingDefects = new Map(
    catalog.existingDefects
      .filter((item) => item.sourceSystem === LEGACY_ACT_SOURCE_SYSTEM && item.sourceImportKey)
      .map((item) => [item.sourceImportKey!, item]),
  );

  for (const group of parsed.groupedActs) {
    const objectKey = foldMatchKey(group.objectNameRaw);
    if (!seenObject.has(objectKey)) {
      seenObject.add(objectKey);
      const matched = matchByName(group.objectNameRaw, catalog.objects, (item) => item.name);
      objectMatches.push({
        result: matched.result,
        matches: matched.matches,
        sourceName: group.objectNameRaw,
      });
      if (matched.result !== 'MATCHED') {
        blockingIssues.push(
          matched.result === 'AMBIGUOUS'
            ? `Неоднозначный объект «${group.objectNameRaw}»`
            : `Объект не найден в справочнике: «${group.objectNameRaw}»`,
        );
      }
    }
    const customerKey = foldMatchKey(group.customerNameRaw);
    if (!seenCustomer.has(customerKey)) {
      seenCustomer.add(customerKey);
      const matched = matchOrganization(group.customerNameRaw, catalog.organizations);
      if (matched.result === 'UNMATCHED') {
        customerMatches.push({
          result: 'CREATE',
          matches: [],
          sourceName: group.customerNameRaw,
        });
        customersToCreate.push(group.customerNameRaw);
      } else {
        customerMatches.push({
          result: matched.result,
          matches: matched.matches,
          sourceName: group.customerNameRaw,
        });
        if (matched.result === 'AMBIGUOUS') {
          blockingIssues.push(`Неоднозначный заказчик «${group.customerNameRaw}»`);
        }
      }
    }

    for (const defect of group.defects) {
      const defectTypeKey = foldMatchKey(defect.defectTypeNameRaw);
      if (!seenDefectType.has(defectTypeKey)) {
        seenDefectType.add(defectTypeKey);
        const matched = matchByName(
          defect.defectTypeNameRaw,
          catalog.defectTypes.filter((item) => item.active),
          (item) => item.name,
        );
        if (matched.result === 'UNMATCHED') {
          defectTypeMatches.push({
            result: 'CREATE',
            matches: [],
            sourceName: defect.defectTypeNameRaw,
          });
          defectTypesToCreate.push(defect.defectTypeNameRaw);
        } else {
          defectTypeMatches.push({
            result: matched.result,
            matches: matched.matches,
            sourceName: defect.defectTypeNameRaw,
          });
          if (matched.result === 'AMBIGUOUS') {
            blockingIssues.push(`Неоднозначный вид дефекта «${defect.defectTypeNameRaw}»`);
          }
        }
      }
      for (const name of defect.liableOrganizationNames) {
        const key = foldMatchKey(name);
        if (seenLiable.has(key)) {
          continue;
        }
        seenLiable.add(key);
        const matched = matchOrganization(name, catalog.organizations);
        if (matched.result === 'UNMATCHED') {
          liableMatches.push({ result: 'CREATE', matches: [], sourceName: name });
          liableOrganizationsToCreate.push(name);
        } else {
          liableMatches.push({
            result: matched.result,
            matches: matched.matches,
            sourceName: name,
          });
          if (matched.result === 'AMBIGUOUS') {
            blockingIssues.push(`Неоднозначная виновная организация «${name}»`);
          }
        }
      }
      for (const name of defect.engineerNames) {
        const key = foldMatchKey(name);
        if (seenEngineer.has(key)) {
          continue;
        }
        seenEngineer.add(key);
        const classified = classifyEngineerMatch(name, catalog.engineers);
        if (classified.result === 'MATCHED' && classified.matches[0]) {
          engineerMatches.push({
            result: 'MATCHED',
            matches: classified.matches,
            sourceName: name,
          });
        } else if (classified.result === 'AMBIGUOUS') {
          engineerMatches.push({
            result: 'AMBIGUOUS',
            matches: classified.matches,
            sourceName: name,
          });
          blockingIssues.push(`Неоднозначный инженер «${name}»`);
        } else if (classified.result === 'INVALID') {
          engineerMatches.push({ result: 'UNMATCHED', matches: [], sourceName: name });
          blockingIssues.push(`Некорректное ФИО инженера «${name}»`);
        } else {
          engineerMatches.push({ result: 'UNMATCHED', matches: [], sourceName: name });
          warnings.push(`Инженер не сопоставлен: «${name}»`);
        }
      }
    }
  }

  const objectByKey = new Map(
    objectMatches
      .filter((item) => item.result === 'MATCHED' && item.matches[0])
      .map((item) => [foldMatchKey(item.sourceName), item.matches[0]!]),
  );
  const orgByKey = new Map(
    [...customerMatches, ...liableMatches]
      .filter((item) => item.result === 'MATCHED' && item.matches[0])
      .map((item) => [foldMatchKey(item.sourceName), item.matches[0]!]),
  );
  const defectTypeByKey = new Map(
    defectTypeMatches
      .filter((item) => item.result === 'MATCHED' && item.matches[0])
      .map((item) => [foldMatchKey(item.sourceName), item.matches[0]!]),
  );
  const engineerByKey = new Map(
    engineerMatches
      .filter((item) => item.result === 'MATCHED' && item.matches[0])
      .map((item) => [foldMatchKey(item.sourceName), item.matches[0]!]),
  );

  let actsToCreate = 0;
  let actsUnchanged = 0;
  let defectsToCreate = 0;
  let defectsUnchanged = 0;
  let liableLinksToCreate = 0;
  let engineerLinksToCreate = 0;
  let unresolvedEngineerLinksToCreate = 0;

  for (const group of parsed.groupedActs) {
    const object = objectByKey.get(foldMatchKey(group.objectNameRaw));
    const customer = orgByKey.get(foldMatchKey(group.customerNameRaw));
    const existing = existingActs.get(group.sourceImportKey);
    const plannedDefects: LegacyActsPlanDefect[] = [];

    for (const defect of group.defects) {
      const defectType = defectTypeByKey.get(foldMatchKey(defect.defectTypeNameRaw));
      const existingDefect = existingDefects.get(defect.sourceImportKey);
      const liableOrganizations = defect.liableOrganizationNames.map((name) => {
        const organization = orgByKey.get(foldMatchKey(name));
        if (organization) {
          return { action: 'link' as const, organization };
        }
        return { action: 'create' as const, name };
      });
      const engineers = defect.engineerNames.flatMap((name): LegacyActsPlanDefect['engineers'] => {
        const match = engineerByKey.get(foldMatchKey(name));
        if (match?.id) {
          return [
            {
              result: 'MATCHED',
              name,
              userId: match.id,
              fullName: match.fullName,
            },
          ];
        }
        if (
          engineerMatches.some(
            (item) =>
              foldMatchKey(item.sourceName) === foldMatchKey(name) && item.result === 'AMBIGUOUS',
          )
        ) {
          return [];
        }
        return [{ result: 'UNMATCHED', name, userId: null, fullName: null }];
      });
      if (existingDefect) {
        const diffs = defectDiffs(
          existingDefect,
          defect,
          defectType,
          liableOrganizations,
          engineers,
        );
        if (diffs.length > 0) {
          plannedDefects.push({
            action: 'conflict',
            sourceImportKey: defect.sourceImportKey,
            group: defect,
            existingId: existingDefect.id,
            defectType,
            createDefectTypeName: defectType ? undefined : defect.defectTypeNameRaw,
            liableOrganizations,
            engineers,
            diffs,
          });
          payloadConflicts.push({ sourceImportKey: defect.sourceImportKey, diffs });
          blockingIssues.push(`Конфликт дефекта ${defect.sourceImportKey}`);
        } else {
          defectsUnchanged += 1;
          plannedDefects.push({
            action: 'unchanged',
            sourceImportKey: defect.sourceImportKey,
            group: defect,
            existingId: existingDefect.id,
            defectType,
            liableOrganizations,
            engineers,
          });
        }
      } else {
        defectsToCreate += 1;
        liableLinksToCreate += liableOrganizations.length;
        engineerLinksToCreate += engineers.filter((item) => item.result === 'MATCHED').length;
        unresolvedEngineerLinksToCreate += engineers.filter(
          (item) => item.result === 'UNMATCHED',
        ).length;
        plannedDefects.push({
          action: 'create',
          sourceImportKey: defect.sourceImportKey,
          group: defect,
          defectType,
          createDefectTypeName: defectType ? undefined : defect.defectTypeNameRaw,
          liableOrganizations,
          engineers,
        });
      }
    }

    if (existing) {
      const diffs = actDiffs(existing, group, object, customer);
      if (diffs.length > 0) {
        payloadConflicts.push({ sourceImportKey: group.sourceImportKey, diffs });
        blockingIssues.push(`Конфликт акта ${group.documentUrl}`);
        acts.push({
          action: 'conflict',
          sourceImportKey: group.sourceImportKey,
          group,
          existingId: existing.id,
          object,
          customer,
          createCustomerName: customer ? undefined : group.customerNameRaw,
          diffs,
          defects: plannedDefects,
        });
      } else {
        actsUnchanged += 1;
        acts.push({
          action: 'unchanged',
          sourceImportKey: group.sourceImportKey,
          group,
          existingId: existing.id,
          object,
          customer,
          defects: plannedDefects,
        });
      }
    } else {
      actsToCreate += 1;
      acts.push({
        action: 'create',
        sourceImportKey: group.sourceImportKey,
        group,
        object,
        customer,
        createCustomerName: customer ? undefined : group.customerNameRaw,
        defects: plannedDefects,
      });
    }
  }

  return {
    actsToCreate,
    actsUnchanged,
    defectsToCreate,
    defectsUnchanged,
    liableLinksToCreate,
    engineerLinksToCreate,
    unresolvedEngineerLinksToCreate,
    customersToCreate: uniquePreserve(customersToCreate),
    liableOrganizationsToCreate: uniquePreserve(liableOrganizationsToCreate),
    defectTypesToCreate: uniquePreserve(defectTypesToCreate),
    objectMatches,
    customerMatches,
    liableMatches,
    engineerMatches,
    defectTypeMatches,
    blockingIssues: uniquePreserve(blockingIssues),
    warnings: uniquePreserve(warnings),
    payloadConflicts,
    groupingConflicts: parsed.groupingConflicts,
    invalidRows: parsed.invalidRows,
    acts,
  };
}

export const SOURCE_OWNED_ACT_COMPARE_FIELDS = [
  'formCode',
  'issuedOn',
  'sourceActNumberRaw',
  'sourceStatusRaw',
  'sourceExternalUrl',
  'objectId',
  'customerOrganizationId',
] as const;

export const OPERATIONAL_OWNED_ACT_FIELDS = ['status', 'startedAt', 'completedAt'] as const;

function actDiffs(
  existing: ExistingLegacyActSnapshot,
  group: GroupedLegacyAct,
  object: LegacyActsCatalogObject | undefined,
  customer: LegacyActsCatalogOrganization | undefined,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  pushDiff(diffs, 'formCode', existing.formCode, group.formCode);
  pushDiff(diffs, 'issuedOn', existing.issuedOn, group.issuedOn);
  pushDiff(diffs, 'sourceActNumberRaw', existing.sourceActNumberRaw, group.actNumberRaw);
  pushDiff(diffs, 'sourceStatusRaw', existing.sourceStatusRaw, group.statusRaw);
  pushDiff(diffs, 'sourceExternalUrl', existing.sourceExternalUrl, group.documentUrl);
  if (object && existing.objectId !== object.id) {
    pushDiff(diffs, 'objectId', existing.objectId, object.id);
  }
  if (customer && existing.customerOrganizationId !== customer.id) {
    pushDiff(diffs, 'customerOrganizationId', existing.customerOrganizationId, customer.id);
  }
  return diffs;
}

function defectDiffs(
  existing: ExistingLegacyDefectSnapshot,
  defect: GroupedLegacyDefect,
  defectType: LegacyActsCatalogDefectType | undefined,
  _liableOrganizations: LegacyActsPlanDefect['liableOrganizations'],
  _engineers: LegacyActsPlanDefect['engineers'],
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  pushDiff(diffs, 'location', existing.location, defect.location);
  pushDiff(diffs, 'sourceDeadlineRaw', existing.sourceDeadlineRaw, defect.deadlineRaw);
  if (defectType && existing.defectTypeName !== defectType.name) {
    pushDiff(diffs, 'defectTypeName', existing.defectTypeName, defectType.name);
  }
  return diffs;
}

function pushDiff(
  diffs: FieldDiff[],
  field: string,
  existing: string | null | undefined,
  incoming: string | null | undefined,
): void {
  const left = existing ?? null;
  const right = incoming ?? null;
  if (left !== right) {
    diffs.push({ field, existing: left, incoming: right });
  }
}
