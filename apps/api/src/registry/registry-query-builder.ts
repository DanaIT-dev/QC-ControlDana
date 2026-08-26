import type { Prisma } from '@sgr-registry/database';
import type { DeadlineState } from '@sgr-registry/contracts';
import {
  addCalendarDays,
  calendarDateToUtcNoon,
  startOfZonedDayUtc,
  type RegistryListQuery,
  type RegistrySortField,
} from '@sgr-registry/domain';
import type { RegistryAccessScope } from './registry-access-scope';

export function searchWhere(search: string | null): Prisma.DefectItemWhereInput | undefined {
  if (!search) {
    return undefined;
  }
  return {
    OR: [
      { act: { officialNumber: { contains: search, mode: 'insensitive' } } },
      { location: { contains: search, mode: 'insensitive' } },
      { act: { propertyObject: { name: { contains: search, mode: 'insensitive' } } } },
      { act: { propertyObject: { address: { contains: search, mode: 'insensitive' } } } },
      { act: { customer: { officialName: { contains: search, mode: 'insensitive' } } } },
      {
        liableOrganizations: {
          some: { organization: { officialName: { contains: search, mode: 'insensitive' } } },
        },
      },
    ],
  };
}

function dateRange(
  from: string | null,
  to: string | null,
): Prisma.DateTimeNullableFilter | undefined {
  if (!from && !to) {
    return undefined;
  }
  return {
    ...(from ? { gte: startOfZonedDayUtc(from) } : {}),
    ...(to ? { lt: startOfZonedDayUtc(addCalendarDays(to, 1)) } : {}),
  };
}

export function deadlineStateWhere(
  state: DeadlineState,
  todayIso: string,
  warningDays: number,
): Prisma.DefectItemWhereInput {
  const todayNoon = calendarDateToUtcNoon(todayIso);
  const warningLastNoon = calendarDateToUtcNoon(addCalendarDays(todayIso, warningDays));
  switch (state) {
    case 'COMPLETED':
      return { status: 'COMPLETED' };
    case 'NO_DEADLINE':
      return { status: 'IN_PROGRESS', effectiveDeadline: null };
    case 'OVERDUE':
      return { status: 'IN_PROGRESS', effectiveDeadline: { lte: todayNoon } };
    case 'WARNING':
      return {
        status: 'IN_PROGRESS',
        effectiveDeadline: { gt: todayNoon, lte: warningLastNoon },
      };
    case 'NORMAL':
      return { status: 'IN_PROGRESS', effectiveDeadline: { gt: warningLastNoon } };
    default:
      return {};
  }
}

export function registryListWhere(
  scope: RegistryAccessScope,
  query: RegistryListQuery,
  todayIso: string,
  warningDays: number,
): Prisma.DefectItemWhereInput {
  const parts: Prisma.DefectItemWhereInput[] = [scope.defectItemWhere()];
  const search = searchWhere(query.search);
  if (search) {
    parts.push(search);
  }
  if (query.formCodes.length) {
    parts.push({ act: { formCode: { in: query.formCodes } } });
  }
  if (query.statuses.length) {
    parts.push({ status: { in: query.statuses } });
  }
  if (query.objectIds.length) {
    parts.push({ act: { objectId: { in: query.objectIds } } });
  }
  if (query.defectTypeIds.length) {
    parts.push({ defectTypeId: { in: query.defectTypeIds } });
  }
  if (query.customerOrganizationIds.length) {
    parts.push({ act: { customerOrganizationId: { in: query.customerOrganizationIds } } });
  }
  if (query.liableOrganizationIds.length) {
    parts.push({
      liableOrganizations: { some: { organizationId: { in: query.liableOrganizationIds } } },
    });
  }
  if (query.responsibleEngineerIds.length) {
    parts.push({
      responsibleEngineers: { some: { userId: { in: query.responsibleEngineerIds } } },
    });
  }
  const planned = dateRange(query.plannedDeadlineFrom, query.plannedDeadlineTo);
  if (planned) {
    parts.push({ plannedDeadline: planned });
  }
  const claim = dateRange(query.claimDeadlineFrom, query.claimDeadlineTo);
  if (claim) {
    parts.push({ claimDeadline: claim });
  }
  const ready = dateRange(query.readyAtFrom, query.readyAtTo);
  if (ready) {
    parts.push({ readyAt: ready });
  }
  if (query.deadlineState.length) {
    parts.push({
      OR: query.deadlineState.map((state) => deadlineStateWhere(state, todayIso, warningDays)),
    });
  }
  return { AND: parts };
}

export function registryOrderBy(
  sortBy: RegistrySortField,
  sortDirection: 'asc' | 'desc',
): Prisma.DefectItemOrderByWithRelationInput[] {
  const dir = sortDirection;
  const deadlineOrder = { sort: dir, nulls: 'last' as const };
  const primary: Prisma.DefectItemOrderByWithRelationInput = (() => {
    switch (sortBy) {
      case 'actNumber':
        return { act: { officialNumber: dir } };
      case 'status':
        return { status: dir };
      case 'objectName':
        return { act: { propertyObject: { name: dir } } };
      case 'defectTypeName':
        return { defectType: { name: dir } };
      case 'plannedDeadline':
        return { plannedDeadline: deadlineOrder };
      case 'claimDeadline':
        return { claimDeadline: deadlineOrder };
      case 'effectiveDeadline':
        return { effectiveDeadline: deadlineOrder };
      case 'readyAt':
        return { readyAt: deadlineOrder };
      case 'createdAt':
        return { createdAt: dir };
      default:
        return { effectiveDeadline: deadlineOrder };
    }
  })();
  return [primary, { act: { officialNumber: 'asc' } }, { id: 'asc' }];
}
