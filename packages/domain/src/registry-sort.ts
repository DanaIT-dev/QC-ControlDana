import type { RegistrySortField, SortDirection } from './registry-query';

export interface RegistrySortRow {
  id: string;
  actId: string;
  defectId: string | null;
  issuedOn: Date | null;
  actCreatedAt: Date;
  officialNumber: string | null;
  status: string;
  objectName: string | null;
  defectTypeName: string | null;
  plannedDeadline: Date | null;
  claimDeadline: Date | null;
  effectiveDeadline: Date | null;
  readyAt: Date | null;
  rowCreatedAt: Date;
}

function instant(value: Date | null): number | null {
  return value ? value.getTime() : null;
}

function compareText(left: string | null, right: string | null, direction: SortDirection): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  const delta = left.localeCompare(right, 'ru', { sensitivity: 'base', numeric: true });
  if (delta === 0) {
    return 0;
  }
  return direction === 'asc' ? delta : -delta;
}

function compareNumber(
  left: number | null,
  right: number | null,
  direction: SortDirection,
): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  if (left === right) {
    return 0;
  }
  const delta = left > right ? 1 : -1;
  return direction === 'asc' ? delta : -delta;
}

function compareId(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function comparePrimary(
  left: RegistrySortRow,
  right: RegistrySortRow,
  sortBy: RegistrySortField,
  direction: SortDirection,
): number {
  switch (sortBy) {
    case 'issuedOn':
      return compareNumber(instant(left.issuedOn), instant(right.issuedOn), direction);
    case 'actNumber':
      return compareText(left.officialNumber, right.officialNumber, direction);
    case 'status':
      return compareText(left.status, right.status, direction);
    case 'objectName':
      return compareText(left.objectName, right.objectName, direction);
    case 'defectTypeName':
      return compareText(left.defectTypeName, right.defectTypeName, direction);
    case 'plannedDeadline':
      return compareNumber(
        instant(left.plannedDeadline),
        instant(right.plannedDeadline),
        direction,
      );
    case 'claimDeadline':
      return compareNumber(instant(left.claimDeadline), instant(right.claimDeadline), direction);
    case 'effectiveDeadline':
      return compareNumber(
        instant(left.effectiveDeadline),
        instant(right.effectiveDeadline),
        direction,
      );
    case 'readyAt':
      return compareNumber(instant(left.readyAt), instant(right.readyAt), direction);
    case 'createdAt':
      return compareNumber(left.rowCreatedAt.getTime(), right.rowCreatedAt.getTime(), direction);
    default:
      return compareNumber(instant(left.issuedOn), instant(right.issuedOn), direction);
  }
}

export function compareRegistrySortRows(
  left: RegistrySortRow,
  right: RegistrySortRow,
  sortBy: RegistrySortField,
  direction: SortDirection,
): number {
  const primary = comparePrimary(left, right, sortBy, direction);
  if (primary !== 0) {
    return primary;
  }
  if (sortBy === 'issuedOn') {
    const created = right.actCreatedAt.getTime() - left.actCreatedAt.getTime();
    if (created !== 0) {
      return created > 0 ? 1 : -1;
    }
    const act = compareId(left.actId, right.actId);
    if (act !== 0) {
      return act;
    }
    return compareId(left.defectId ?? '', right.defectId ?? '');
  }
  const number = compareText(left.officialNumber, right.officialNumber, 'asc');
  if (number !== 0) {
    return number;
  }
  const act = compareId(left.actId, right.actId);
  if (act !== 0) {
    return act;
  }
  return compareId(left.defectId ?? '', right.defectId ?? '');
}
