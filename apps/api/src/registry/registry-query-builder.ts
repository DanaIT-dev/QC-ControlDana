import type { Prisma } from '@sgr-registry/database';
import type { DeadlineState, RegistryStatusFilter } from '@sgr-registry/contracts';
import {
  addCalendarDays,
  calendarDateToUtcNoon,
  foldPersonSearchKey,
  startOfZonedDayUtc,
  type RegistryListQuery,
  type RegistrySortField,
} from '@sgr-registry/domain';
import type { RegistryAccessScope } from './registry-access-scope.js';

function likeNeedle(search: string): string {
  return `%${foldPersonSearchKey(search).replace(/[\\%_]/g, '\\$&')}%`;
}

export async function personSearchDefectItemIds(
  prisma: { $queryRaw: Prisma.TransactionClient['$queryRaw'] },
  search: string,
): Promise<string[]> {
  const needle = likeNeedle(search);
  if (needle === '%%') {
    return [];
  }
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT d.id
    FROM public.defect_items d
    WHERE EXISTS (
      SELECT 1
      FROM public.defect_item_engineers e
      JOIN public.users u ON u.id = e."userId"
      WHERE e."defectItemId" = d.id
        AND public.sgr_person_search_blob(u."fullName") LIKE ${needle} ESCAPE '\\'
    )
    OR EXISTS (
      SELECT 1
      FROM public.imported_engineer_references r
      WHERE r."defectItemId" = d.id
        AND public.sgr_person_search_blob(r."sourceNameRaw") LIKE ${needle} ESCAPE '\\'
    )
    LIMIT 5000
  `;
  return rows.map((row) => row.id);
}

export function searchWhere(
  search: string | null,
  personDefectIds: string[] = [],
): Prisma.DefectItemWhereInput | undefined {
  if (!search) {
    return undefined;
  }
  const personIds =
    personDefectIds.length > 0 ? personDefectIds : ['00000000-0000-4000-8000-000000000000'];
  return {
    OR: [
      { act: { officialNumber: { contains: search, mode: 'insensitive' } } },
      { act: { sourceActNumberRaw: { contains: search, mode: 'insensitive' } } },
      { location: { contains: search, mode: 'insensitive' } },
      { act: { propertyObject: { name: { contains: search, mode: 'insensitive' } } } },
      { act: { propertyObject: { address: { contains: search, mode: 'insensitive' } } } },
      { act: { customer: { officialName: { contains: search, mode: 'insensitive' } } } },
      {
        liableOrganizations: {
          some: { organization: { officialName: { contains: search, mode: 'insensitive' } } },
        },
      },
      {
        responsibleEngineers: {
          some: { user: { fullName: { contains: search, mode: 'insensitive' } } },
        },
      },
      {
        importedEngineerReferences: {
          some: { sourceNameRaw: { contains: search, mode: 'insensitive' } },
        },
      },
      { id: { in: personIds } },
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
      return {
        status: { in: ['IN_PROGRESS', 'PENDING_INSPECTION'] },
        act: { status: 'IN_PROGRESS' },
        effectiveDeadline: null,
      };
    case 'OVERDUE':
      return {
        status: { in: ['IN_PROGRESS', 'PENDING_INSPECTION'] },
        act: { status: 'IN_PROGRESS' },
        effectiveDeadline: { lte: todayNoon },
      };
    case 'WARNING':
      return {
        status: { in: ['IN_PROGRESS', 'PENDING_INSPECTION'] },
        act: { status: 'IN_PROGRESS' },
        effectiveDeadline: { gt: todayNoon, lte: warningLastNoon },
      };
    case 'NORMAL':
      return {
        status: { in: ['IN_PROGRESS', 'PENDING_INSPECTION'] },
        act: { status: 'IN_PROGRESS' },
        effectiveDeadline: { gt: warningLastNoon },
      };
    default:
      return {};
  }
}

export function registryListWhere(
  scope: RegistryAccessScope,
  query: RegistryListQuery,
  todayIso: string,
  warningDays: number,
  personSearchDefectIds: string[] = [],
): Prisma.DefectItemWhereInput {
  const parts: Prisma.DefectItemWhereInput[] = [
    scope.defectItemWhere({ includeCancelled: query.statuses.includes('CANCELLED') }),
  ];
  const search = searchWhere(query.search, personSearchDefectIds);
  if (search) {
    parts.push(search);
  }
  if (query.formCodes.length) {
    parts.push({ act: { formCode: { in: query.formCodes } } });
  }
  if (query.statuses.length) {
    parts.push({
      OR: query.statuses.map((status) => registryStatusFilterWhere(status)),
    });
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
  if (query.unmatchedEngineers) {
    parts.push({
      importedEngineerReferences: { some: { resolutionStatus: 'UNMATCHED' } },
    });
  }
  if (query.importedOnly) {
    parts.push({ act: { importedAt: { not: null } } });
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

export function registryStatusFilterWhere(
  status: RegistryStatusFilter,
): Prisma.DefectItemWhereInput {
  if (status === 'NEW') {
    return { act: { status: 'NEW' } };
  }
  if (status === 'IMPORTED_UNSPECIFIED') {
    return { act: { status: 'IMPORTED_UNSPECIFIED' } };
  }
  if (status === 'IN_PROGRESS') {
    return { status: 'IN_PROGRESS', act: { status: 'IN_PROGRESS' } };
  }
  if (status === 'CANCELLED') {
    return { act: { status: 'CANCELLED' } };
  }
  return { status: 'COMPLETED' };
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
        return { act: { status: dir } };
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
