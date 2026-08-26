import {
  ACT_FORM_CODES,
  DEFECT_ITEM_STATUSES,
  type ActFormCode,
  type DefectItemStatus,
} from '@sgr-registry/contracts';
import { DEADLINE_STATES, type DeadlineState } from '@sgr-registry/contracts';

export const REGISTRY_PAGE_SIZES = [25, 50, 100, 200] as const;
export type RegistryPageSize = (typeof REGISTRY_PAGE_SIZES)[number];
export const DEFAULT_REGISTRY_PAGE_SIZE: RegistryPageSize = 50;
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 200;

export const REGISTRY_SORT_FIELDS = [
  'actNumber',
  'status',
  'objectName',
  'defectTypeName',
  'plannedDeadline',
  'claimDeadline',
  'effectiveDeadline',
  'readyAt',
  'createdAt',
] as const;

export type RegistrySortField = (typeof REGISTRY_SORT_FIELDS)[number];
export type SortDirection = 'asc' | 'desc';

export const DEFAULT_REGISTRY_SORT = {
  sortBy: 'effectiveDeadline' as const,
  sortDirection: 'asc' as const,
};

export class RegistryQueryError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'RegistryQueryError';
  }
}

export interface RegistryListQuery {
  page: number;
  pageSize: RegistryPageSize;
  search: string | null;
  formCodes: ActFormCode[];
  statuses: DefectItemStatus[];
  objectIds: string[];
  defectTypeIds: string[];
  customerOrganizationIds: string[];
  liableOrganizationIds: string[];
  responsibleEngineerIds: string[];
  plannedDeadlineFrom: string | null;
  plannedDeadlineTo: string | null;
  claimDeadlineFrom: string | null;
  claimDeadlineTo: string | null;
  readyAtFrom: string | null;
  readyAtTo: string | null;
  deadlineState: DeadlineState[];
  sortBy: RegistrySortField;
  sortDirection: SortDirection;
}

export interface RegistryQueryInput {
  [key: string]: string | string[] | undefined;
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function optionalCalendarDate(value: string | undefined, field: string): string | null {
  if (!value || value.trim().length === 0) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new RegistryQueryError(`Invalid ${field} date`);
  }
  return trimmed;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parsePositiveInt(value: string | undefined, field: string, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new RegistryQueryError(`Invalid ${field}`);
  }
  return Number.parseInt(trimmed, 10);
}

function parsePageSize(value: string | undefined): RegistryPageSize {
  if (value === undefined || value.trim().length === 0) {
    return DEFAULT_REGISTRY_PAGE_SIZE;
  }
  const parsed = parsePositiveInt(value, 'pageSize', DEFAULT_REGISTRY_PAGE_SIZE);
  if (!REGISTRY_PAGE_SIZES.includes(parsed as RegistryPageSize)) {
    throw new RegistryQueryError('Invalid pageSize');
  }
  return parsed as RegistryPageSize;
}

function parseIdList(value: string | string[] | undefined, field: string): string[] {
  return asList(value).map((id) => {
    if (!UUID_PATTERN.test(id)) {
      throw new RegistryQueryError(`Invalid ${field}`);
    }
    return id;
  });
}

export function parseRegistryListQuery(input: RegistryQueryInput): RegistryListQuery {
  const pageRaw =
    input.page === undefined ? '1' : Array.isArray(input.page) ? input.page[0] : input.page;
  const page = parsePositiveInt(pageRaw, 'page', 1);
  if (!Number.isInteger(page) || page < 1) {
    throw new RegistryQueryError('Invalid page');
  }

  const pageSize = parsePageSize(
    Array.isArray(input.pageSize) ? input.pageSize[0] : input.pageSize,
  );

  const searchRaw = Array.isArray(input.search) ? input.search[0] : input.search;
  const trimmedSearch = searchRaw?.trim() ?? '';
  if (trimmedSearch.length > SEARCH_MAX_LENGTH) {
    throw new RegistryQueryError('Search query is too long');
  }
  const search = trimmedSearch.length >= SEARCH_MIN_LENGTH ? trimmedSearch : null;

  const formCodes = asList(input.formCodes).map((code) => {
    if (!ACT_FORM_CODES.includes(code as ActFormCode)) {
      throw new RegistryQueryError('Invalid form code');
    }
    return code as ActFormCode;
  });

  const statuses = asList(input.statuses).map((status) => {
    if (!DEFECT_ITEM_STATUSES.includes(status as DefectItemStatus)) {
      throw new RegistryQueryError('Invalid status');
    }
    return status as DefectItemStatus;
  });

  const deadlineState = asList(input.deadlineState).map((state) => {
    if (!DEADLINE_STATES.includes(state as DeadlineState)) {
      throw new RegistryQueryError('Invalid deadline state');
    }
    return state as DeadlineState;
  });

  const sortByRaw = Array.isArray(input.sortBy) ? input.sortBy[0] : input.sortBy;
  const sortBy = (sortByRaw as RegistrySortField | undefined) ?? DEFAULT_REGISTRY_SORT.sortBy;
  if (!REGISTRY_SORT_FIELDS.includes(sortBy)) {
    throw new RegistryQueryError('Invalid sort field');
  }

  const sortDirectionRaw = Array.isArray(input.sortDirection)
    ? input.sortDirection[0]
    : input.sortDirection;
  const sortDirection =
    (sortDirectionRaw as SortDirection | undefined) ?? DEFAULT_REGISTRY_SORT.sortDirection;
  if (sortDirection !== 'asc' && sortDirection !== 'desc') {
    throw new RegistryQueryError('Invalid sort direction');
  }

  return {
    page,
    pageSize,
    search,
    formCodes,
    statuses,
    objectIds: parseIdList(input.objectIds, 'objectIds'),
    defectTypeIds: parseIdList(input.defectTypeIds, 'defectTypeIds'),
    customerOrganizationIds: parseIdList(input.customerOrganizationIds, 'customerOrganizationIds'),
    liableOrganizationIds: parseIdList(input.liableOrganizationIds, 'liableOrganizationIds'),
    responsibleEngineerIds: parseIdList(input.responsibleEngineerIds, 'responsibleEngineerIds'),
    plannedDeadlineFrom: optionalCalendarDate(
      Array.isArray(input.plannedDeadlineFrom)
        ? input.plannedDeadlineFrom[0]
        : input.plannedDeadlineFrom,
      'plannedDeadlineFrom',
    ),
    plannedDeadlineTo: optionalCalendarDate(
      Array.isArray(input.plannedDeadlineTo) ? input.plannedDeadlineTo[0] : input.plannedDeadlineTo,
      'plannedDeadlineTo',
    ),
    claimDeadlineFrom: optionalCalendarDate(
      Array.isArray(input.claimDeadlineFrom) ? input.claimDeadlineFrom[0] : input.claimDeadlineFrom,
      'claimDeadlineFrom',
    ),
    claimDeadlineTo: optionalCalendarDate(
      Array.isArray(input.claimDeadlineTo) ? input.claimDeadlineTo[0] : input.claimDeadlineTo,
      'claimDeadlineTo',
    ),
    readyAtFrom: optionalCalendarDate(
      Array.isArray(input.readyAtFrom) ? input.readyAtFrom[0] : input.readyAtFrom,
      'readyAtFrom',
    ),
    readyAtTo: optionalCalendarDate(
      Array.isArray(input.readyAtTo) ? input.readyAtTo[0] : input.readyAtTo,
      'readyAtTo',
    ),
    deadlineState,
    sortBy,
    sortDirection,
  };
}

export function serializeRegistryQuery(query: RegistryListQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.page !== 1) {
    params.page = String(query.page);
  }
  if (query.pageSize !== DEFAULT_REGISTRY_PAGE_SIZE) {
    params.pageSize = String(query.pageSize);
  }
  if (query.search) {
    params.search = query.search;
  }
  const arrays: Array<[string, string[]]> = [
    ['formCodes', query.formCodes],
    ['statuses', query.statuses],
    ['objectIds', query.objectIds],
    ['defectTypeIds', query.defectTypeIds],
    ['customerOrganizationIds', query.customerOrganizationIds],
    ['liableOrganizationIds', query.liableOrganizationIds],
    ['responsibleEngineerIds', query.responsibleEngineerIds],
    ['deadlineState', query.deadlineState],
  ];
  for (const [key, values] of arrays) {
    if (values.length > 0) {
      params[key] = values.join(',');
    }
  }
  const dates: Array<[string, string | null]> = [
    ['plannedDeadlineFrom', query.plannedDeadlineFrom],
    ['plannedDeadlineTo', query.plannedDeadlineTo],
    ['claimDeadlineFrom', query.claimDeadlineFrom],
    ['claimDeadlineTo', query.claimDeadlineTo],
    ['readyAtFrom', query.readyAtFrom],
    ['readyAtTo', query.readyAtTo],
  ];
  for (const [key, value] of dates) {
    if (value) {
      params[key] = value;
    }
  }
  if (query.sortBy !== DEFAULT_REGISTRY_SORT.sortBy) {
    params.sortBy = query.sortBy;
  }
  if (query.sortDirection !== DEFAULT_REGISTRY_SORT.sortDirection) {
    params.sortDirection = query.sortDirection;
  }
  return params;
}

export function countActiveRegistryFilters(query: RegistryListQuery): number {
  let count = 0;
  if (query.search) count += 1;
  if (query.formCodes.length) count += 1;
  if (query.statuses.length) count += 1;
  if (query.objectIds.length) count += 1;
  if (query.defectTypeIds.length) count += 1;
  if (query.customerOrganizationIds.length) count += 1;
  if (query.liableOrganizationIds.length) count += 1;
  if (query.responsibleEngineerIds.length) count += 1;
  if (query.plannedDeadlineFrom || query.plannedDeadlineTo) count += 1;
  if (query.claimDeadlineFrom || query.claimDeadlineTo) count += 1;
  if (query.readyAtFrom || query.readyAtTo) count += 1;
  if (query.deadlineState.length) count += 1;
  return count;
}

export function isEmptyRegistryQuery(query: RegistryListQuery): boolean {
  return countActiveRegistryFilters(query) === 0 && query.page === 1;
}

export function normalizeQueryInput(query: Record<string, unknown>): RegistryQueryInput {
  const result: RegistryQueryInput = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string' && !Array.isArray(value)) {
      continue;
    }
    const name = key.endsWith('[]') ? key.slice(0, -2) : key;
    const asStrings = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : value;
    const existing = result[name];
    if (existing === undefined) {
      result[name] = asStrings;
      continue;
    }
    const left = Array.isArray(existing) ? existing : [existing];
    const right = Array.isArray(asStrings) ? asStrings : [asStrings];
    result[name] = [...left, ...right];
  }
  return result;
}
