import type { OrganizationRole } from '@sgr-registry/contracts';
import { APPROVED_DEFECT_TYPES_SOURCE, APPROVED_DEFECT_TYPES_V1 } from './approved-defect-types';
import { isValidEmail } from './email';
import { foldKey, normalizeOptionalText, normalizeUnicode } from './text';
import { normalizeUnp } from './unp';

export const WORK_TYPES_SHEET_NAME = 'Виды работ';
export const ORGANIZATIONS_SHEET_NAME = 'Организации';
export const ACTS_REGISTRY_SHEET_NAME = 'Реестр актов';
export const WORK_TYPE_CODE_PREFIX = 'WT';

const SKIPPED_WORK_TYPE_KEYS = new Set(['исключен из егр']);
const PLACEHOLDER_ORG_KEYS = new Set(['–', '-', 'не установлена']);

export type DirectoryImportAction = 'create' | 'update' | 'unchanged' | 'skip_duplicate';

export interface DirectoryCodedItem {
  sortOrder: number;
  code: string;
  name: string;
}

export interface ParsedWorkTypeRow {
  sourceRow: number;
  sortOrder: number;
  name: string;
}

export interface ParsedOrganizationRow {
  sourceRow: number;
  officialName: string;
  unp: string | null;
  postalAddress: string | null;
  email: string | null;
  phone: string | null;
  contactPerson: string | null;
  active: boolean;
  roles: OrganizationRole[];
  workTypeName: string | null;
}

export interface WorkTypesParseResult {
  sheet: string;
  range: string;
  headers: string[];
  nonemptyRows: number;
  blankRows: number;
  uniqueValues: number;
  exactDuplicates: number;
  conflicts: number;
  rows: ParsedWorkTypeRow[];
}

export interface OrganizationsParseResult {
  sheet: string;
  headers: string[];
  organizationRoles: OrganizationRole[];
  rows: number;
  duplicates: number;
  missingRequiredFields: number;
  items: ParsedOrganizationRow[];
  skipped: Array<{ sourceRow: number; reason: string }>;
}

export interface DirectorySyncPlan {
  create: number;
  update: number;
  unchanged: number;
  duplicates: number;
}

export interface DefectTypesSyncPlan extends DirectorySyncPlan {
  approvedCount: number;
  active: number;
  inactive: number;
  unexpected: Array<{ id: string; name: string; code: string }>;
  exactOrder: boolean;
  items: Array<{
    action: DirectoryImportAction;
    name: string;
    code: string;
    sortOrder: number;
    existingId?: string;
  }>;
}

export interface ExistingCodedDirectoryRow {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface ExistingOrganizationRow {
  id: string;
  officialName: string;
  unp: string | null;
  postalAddress: string | null;
  email: string | null;
  phone: string | null;
  contactPerson: string | null;
  active: boolean;
  roles: OrganizationRole[];
}

function cellText(value: unknown): string {
  if (value == null || value === '') {
    return '';
  }
  if (typeof value === 'string') {
    return normalizeUnicode(value).trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    const record = value as {
      text?: unknown;
      result?: unknown;
      richText?: Array<{ text?: string }>;
      hyperlink?: unknown;
    };
    if (Array.isArray(record.richText)) {
      return normalizeUnicode(record.richText.map((part) => part.text ?? '').join('')).trim();
    }
    if (typeof record.text === 'string') {
      return normalizeUnicode(record.text).trim();
    }
    if (record.result !== undefined) {
      return cellText(record.result);
    }
    if (typeof record.hyperlink === 'string') {
      return record.hyperlink.trim();
    }
  }
  return String(value).trim();
}

function headerKey(value: string): string {
  return foldKey(value.replace(/\s+/g, ' '));
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0]?.trim() ?? '';
}

function isPlaceholderOrgName(name: string): boolean {
  const key = foldKey(name);
  if (!name || PLACEHOLDER_ORG_KEYS.has(key)) {
    return true;
  }
  return key.startsWith('собственник') || key.startsWith('председатель');
}

function shouldSkipWorkType(name: string): boolean {
  return SKIPPED_WORK_TYPE_KEYS.has(foldKey(name));
}

export function workTypeCodeForName(name: string, sortOrder: number): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 24);
  const suffix = slug.length > 0 ? slug : 'VALUE';
  return `${WORK_TYPE_CODE_PREFIX}_${String(sortOrder).padStart(2, '0')}_${suffix}`.slice(0, 40);
}

export function parseWorkTypeValues(
  values: readonly unknown[],
  sheet = WORK_TYPES_SHEET_NAME,
): WorkTypesParseResult {
  let nonemptyRows = 0;
  let blankRows = 0;
  let exactDuplicates = 0;
  const seen = new Map<string, ParsedWorkTypeRow>();
  const rows: ParsedWorkTypeRow[] = [];
  values.forEach((value, index) => {
    const sourceRow = index + 1;
    const name = cellText(value);
    if (!name) {
      blankRows += 1;
      return;
    }
    nonemptyRows += 1;
    if (sourceRow === 1 && foldKey(name) === foldKey(WORK_TYPES_SHEET_NAME)) {
      return;
    }
    if (shouldSkipWorkType(name)) {
      return;
    }
    const key = name;
    const existing = seen.get(key);
    if (existing) {
      exactDuplicates += 1;
      return;
    }
    const row = { sourceRow, sortOrder: rows.length + 1, name };
    seen.set(key, row);
    rows.push(row);
  });
  return {
    sheet,
    range: values.length > 0 ? `A1:A${values.length}` : 'A1:A1',
    headers: [WORK_TYPES_SHEET_NAME],
    nonemptyRows,
    blankRows,
    uniqueValues: rows.length,
    exactDuplicates,
    conflicts: 0,
    rows,
  };
}

export function mergeWorkTypeSources(
  sheetValues: readonly unknown[],
  organizationWorkTypes: readonly string[],
): WorkTypesParseResult {
  const fromSheet = parseWorkTypeValues(sheetValues, WORK_TYPES_SHEET_NAME);
  if (fromSheet.rows.length > 0) {
    return fromSheet;
  }
  const fallback = parseWorkTypeValues(
    ['Виды работ', ...organizationWorkTypes],
    ORGANIZATIONS_SHEET_NAME,
  );
  return {
    ...fallback,
    sheet: ORGANIZATIONS_SHEET_NAME,
    range: 'D',
    headers: ['Вид выполняемых работ'],
  };
}

function findHeaderIndex(headers: readonly string[], candidates: readonly string[]): number {
  const wanted = candidates.map(headerKey);
  return headers.findIndex((header) => wanted.includes(headerKey(header)));
}

export function parseOrganizationsMatrix(
  rows: readonly unknown[][],
  actRoles?: { customers: readonly string[]; liable: readonly string[] },
): OrganizationsParseResult {
  const headerRow = rows[0] ?? [];
  const headers = headerRow.map((cell) => cellText(cell));
  const nameIdx = findHeaderIndex(headers, ['Наименование организации']);
  const statusIdx = findHeaderIndex(headers, ['Статус']);
  const workTypeIdx = findHeaderIndex(headers, ['Вид выполняемых работ']);
  const unpIdx = findHeaderIndex(headers, ['УНП/ИНН', 'УНП ИНН', 'УНП', 'ИНН']);
  const addressIdx = findHeaderIndex(headers, ['Почтовый адрес']);
  const emailIdx = findHeaderIndex(headers, ['Адрес электронной почты', 'email', 'e-mail']);
  const personIdx = findHeaderIndex(headers, ['Контактное лицо']);
  const phoneIdx = findHeaderIndex(headers, ['Контактный телефон', 'телефон']);
  const customerKeys = new Set((actRoles?.customers ?? []).map((item) => foldKey(item)));
  const liableKeys = new Set((actRoles?.liable ?? []).map((item) => foldKey(item)));
  const requireRoles = customerKeys.size > 0 || liableKeys.size > 0;
  const seen = new Map<string, ParsedOrganizationRow>();
  const items: ParsedOrganizationRow[] = [];
  const skipped: OrganizationsParseResult['skipped'] = [];
  let duplicates = 0;
  let missingRequiredFields = 0;

  rows.forEach((row, index) => {
    if (index === 0) {
      return;
    }
    const sourceRow = index + 1;
    const officialName = nameIdx >= 0 ? cellText(row[nameIdx]) : '';
    if (!officialName) {
      return;
    }
    if (isPlaceholderOrgName(officialName)) {
      skipped.push({ sourceRow, reason: 'placeholder_or_person' });
      return;
    }
    const roles: OrganizationRole[] = [];
    const key = foldKey(officialName);
    if (customerKeys.has(key)) {
      roles.push('CUSTOMER');
    }
    if (liableKeys.has(key)) {
      roles.push('LIABLE_CONTRACTOR');
    }
    if (requireRoles && roles.length === 0) {
      skipped.push({ sourceRow, reason: 'not_required_for_act' });
      return;
    }
    if (seen.has(key)) {
      duplicates += 1;
      skipped.push({ sourceRow, reason: 'duplicate' });
      return;
    }
    const status = statusIdx >= 0 ? cellText(row[statusIdx]) : '';
    const emailRaw = emailIdx >= 0 ? cellText(row[emailIdx]) : '';
    const emailCandidate = firstLine(emailRaw);
    const email =
      emailCandidate && isValidEmail(emailCandidate) ? emailCandidate.toLowerCase() : null;
    const parsed: ParsedOrganizationRow = {
      sourceRow,
      officialName,
      unp: normalizeUnp(unpIdx >= 0 ? cellText(row[unpIdx]) || null : null),
      postalAddress: normalizeOptionalText(
        addressIdx >= 0 ? cellText(row[addressIdx]) : '',
        'postalAddress',
        1000,
      ),
      email,
      phone: normalizeOptionalText(phoneIdx >= 0 ? cellText(row[phoneIdx]) : '', 'phone', 200),
      contactPerson: normalizeOptionalText(
        personIdx >= 0 ? cellText(row[personIdx]) : '',
        'contactPerson',
        200,
      ),
      active: foldKey(status) !== 'недействующий',
      roles,
      workTypeName: workTypeIdx >= 0 ? cellText(row[workTypeIdx]) || null : null,
    };
    if (!parsed.officialName) {
      missingRequiredFields += 1;
      skipped.push({ sourceRow, reason: 'missing_name' });
      return;
    }
    seen.set(key, parsed);
    items.push(parsed);
  });

  const organizationRoles = [...new Set(items.flatMap((item) => item.roles))];
  return {
    sheet: ORGANIZATIONS_SHEET_NAME,
    headers: headers.filter((item) => item.length > 0),
    organizationRoles,
    rows: items.length,
    duplicates,
    missingRequiredFields,
    items,
    skipped,
  };
}

export function parseActOrganizationRoles(rows: readonly unknown[][]): {
  customers: string[];
  liable: string[];
} {
  const headerRow = rows.find((row) => row.some((cell) => foldKey(cellText(cell)) === 'заказчик'));
  if (!headerRow) {
    return { customers: [], liable: [] };
  }
  const headers = headerRow.map((cell) => cellText(cell));
  const customerIdx = findHeaderIndex(headers, ['Заказчик']);
  const liableIdx = findHeaderIndex(headers, ['Виновная организация']);
  const customers: string[] = [];
  const liable: string[] = [];
  const customerSeen = new Set<string>();
  const liableSeen = new Set<string>();
  const headerIndex = rows.indexOf(headerRow);
  for (const row of rows.slice(headerIndex + 1)) {
    const customer = customerIdx >= 0 ? cellText(row[customerIdx]) : '';
    const liableName = liableIdx >= 0 ? cellText(row[liableIdx]) : '';
    if (customer && !isPlaceholderOrgName(customer) && !customerSeen.has(customer)) {
      customerSeen.add(customer);
      customers.push(customer);
    }
    if (liableName && !isPlaceholderOrgName(liableName) && !liableSeen.has(liableName)) {
      liableSeen.add(liableName);
      liable.push(liableName);
    }
  }
  return { customers, liable };
}

export function parseOrganizationWorkTypeColumn(rows: readonly unknown[][]): string[] {
  const headerRow = rows[0] ?? [];
  const headers = headerRow.map((cell) => cellText(cell));
  const workTypeIdx = findHeaderIndex(headers, ['Вид выполняемых работ']);
  if (workTypeIdx < 0) {
    return [];
  }
  const names: string[] = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((row) => {
    const name = cellText(row[workTypeIdx]);
    if (!name || shouldSkipWorkType(name) || seen.has(name)) {
      return;
    }
    seen.add(name);
    names.push(name);
  });
  return names;
}

export function organizationWorkTypeNames(rows: readonly ParsedOrganizationRow[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.workTypeName?.trim() ?? '';
    if (!name || shouldSkipWorkType(name) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function planCodedDirectorySync(
  existing: readonly ExistingCodedDirectoryRow[],
  incoming: readonly DirectoryCodedItem[],
): DirectorySyncPlan & {
  items: Array<{
    action: DirectoryImportAction;
    name: string;
    code: string;
    sortOrder: number;
    existingId?: string;
  }>;
} {
  const byName = new Map(existing.map((row) => [row.name, row]));
  const byCode = new Map(existing.map((row) => [row.code, row]));
  const usedIds = new Set<string>();
  const items: Array<{
    action: DirectoryImportAction;
    name: string;
    code: string;
    sortOrder: number;
    existingId?: string;
  }> = [];
  let create = 0;
  let update = 0;
  let unchanged = 0;
  for (const item of incoming) {
    const matched =
      byName.get(item.name) ??
      (!usedIds.has(byCode.get(item.code)?.id ?? '') ? byCode.get(item.code) : undefined);
    if (!matched) {
      create += 1;
      items.push({ action: 'create', ...item });
      continue;
    }
    usedIds.add(matched.id);
    const same =
      matched.name === item.name && matched.sortOrder === item.sortOrder && matched.active === true;
    if (same) {
      unchanged += 1;
      items.push({ action: 'unchanged', ...item, existingId: matched.id, code: matched.code });
    } else {
      update += 1;
      items.push({ action: 'update', ...item, existingId: matched.id, code: matched.code });
    }
  }
  return { create, update, unchanged, duplicates: 0, items };
}

export function planApprovedDefectTypesSync(
  existing: readonly ExistingCodedDirectoryRow[],
): DefectTypesSyncPlan {
  const incoming = APPROVED_DEFECT_TYPES_V1.map((item) => ({
    sortOrder: item.sortOrder,
    code: item.code,
    name: item.name,
  }));
  const planned = planCodedDirectorySync(existing, incoming);
  const approvedNames = new Set<string>(APPROVED_DEFECT_TYPES_V1.map((item) => item.name));
  const unexpected = existing.filter((row) => !approvedNames.has(row.name));
  const matchedOrder = planned.items
    .filter((item) => item.action !== 'create')
    .map((item) => existing.find((row) => row.id === item.existingId)?.sortOrder);
  const expectedOrder = APPROVED_DEFECT_TYPES_V1.map((item) => item.sortOrder);
  const exactOrder =
    unexpected.length === 0 &&
    existing.filter((row) => row.active).length === incoming.length &&
    incoming.every((item, index) => {
      const row = existing.find((candidate) => candidate.name === item.name);
      return row?.sortOrder === expectedOrder[index];
    });
  return {
    ...planned,
    approvedCount: incoming.length,
    active: existing.filter((row) => row.active).length,
    inactive: existing.filter((row) => !row.active).length,
    unexpected: unexpected.map((row) => ({ id: row.id, name: row.name, code: row.code })),
    exactOrder: exactOrder && matchedOrder.length === incoming.length,
    items: planned.items,
  };
}

export function planOrganizationSync(
  existing: readonly ExistingOrganizationRow[],
  incoming: readonly ParsedOrganizationRow[],
): DirectorySyncPlan & {
  items: Array<{ action: DirectoryImportAction; row: ParsedOrganizationRow; existingId?: string }>;
} {
  const byName = new Map(existing.map((row) => [foldKey(row.officialName), row]));
  const byUnp = new Map(existing.filter((row) => row.unp).map((row) => [row.unp as string, row]));
  const items: Array<{
    action: DirectoryImportAction;
    row: ParsedOrganizationRow;
    existingId?: string;
  }> = [];
  let create = 0;
  let update = 0;
  let unchanged = 0;
  for (const row of incoming) {
    const matched =
      (row.unp ? byUnp.get(row.unp) : undefined) ?? byName.get(foldKey(row.officialName));
    if (!matched) {
      create += 1;
      items.push({ action: 'create', row });
      continue;
    }
    const sameRoles = [...matched.roles].sort().join(',') === [...row.roles].sort().join(',');
    const same =
      matched.officialName === row.officialName &&
      matched.unp === row.unp &&
      matched.postalAddress === row.postalAddress &&
      matched.email === row.email &&
      matched.phone === row.phone &&
      matched.contactPerson === row.contactPerson &&
      matched.active === row.active &&
      sameRoles;
    if (same) {
      unchanged += 1;
      items.push({ action: 'unchanged', row, existingId: matched.id });
    } else {
      update += 1;
      items.push({ action: 'update', row, existingId: matched.id });
    }
  }
  return { create, update, unchanged, duplicates: 0, items };
}

export { APPROVED_DEFECT_TYPES_SOURCE };
