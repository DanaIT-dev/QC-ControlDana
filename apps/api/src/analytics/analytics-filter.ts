import type { AnalyticsQuery } from '@sgr-registry/contracts';
import { Prisma } from '@sgr-registry/database';
import {
  ANALYTICS_NO_MOVEMENT_DAYS,
  minskDayEnd,
  minskDayStart,
  type AnalyticsMetric,
} from '@sgr-registry/domain';
import { registryAccessMode } from '@sgr-registry/domain';
import type { RegistryAccessScope } from '../registry/registry-access-scope.js';

export function analyticsDefectWhere(
  scope: RegistryAccessScope,
  query: AnalyticsQuery,
  metric?: AnalyticsMetric,
): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  const mode = registryAccessMode(scope.role);
  if (mode !== 'all') {
    parts.push(Prisma.sql`a.status <> 'CANCELLED'`);
  }
  if (mode === 'object_assigned') {
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM public.property_object_engineers engineer
      WHERE engineer."propertyObjectId" = a."objectId"
        AND engineer."userId" = ${scope.userId}::uuid
        AND engineer."unassignedAt" IS NULL
    )`);
  }
  if (mode === 'organization_liable') {
    parts.push(organizationScopeSql(scope.organizationIds));
  }
  if (query.dateFrom) {
    parts.push(Prisma.sql`d."createdAt" >= ${minskDayStart(query.dateFrom)}`);
  }
  if (query.dateTo) {
    parts.push(Prisma.sql`d."createdAt" <= ${minskDayEnd(query.dateTo)}`);
  }
  if (query.propertyObjectId) {
    parts.push(Prisma.sql`a."objectId" = ${query.propertyObjectId}::uuid`);
  }
  if (query.customerOrganizationId) {
    parts.push(Prisma.sql`a."customerOrganizationId" = ${query.customerOrganizationId}::uuid`);
  }
  if (query.liableOrganizationId) {
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM public.defect_item_liable_organizations liable
      WHERE liable."defectItemId" = d.id
        AND liable."organizationId" = ${query.liableOrganizationId}::uuid
    )`);
  }
  if (query.workTypeId) {
    parts.push(Prisma.sql`d."workTypeId" = ${query.workTypeId}::uuid`);
  }
  if (query.defectTypeId) {
    parts.push(Prisma.sql`d."defectTypeId" = ${query.defectTypeId}::uuid`);
  }
  if (query.status) {
    parts.push(Prisma.sql`d.status::text = ${query.status}`);
  }
  if (query.deadlineState) {
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM public.sla_clocks clock
      WHERE clock."defectItemId" = d.id
        AND clock.kind::text = 'GENERAL'
        AND clock.state::text = ${query.deadlineState}
    )`);
  }
  if (query.source === 'imported' || query.importedOnly === 'true') {
    parts.push(importedSql());
  }
  if (query.source === 'manual') {
    parts.push(Prisma.sql`d."importBatchId" IS NULL AND d."sourceSystem" IS NULL`);
  }
  if (query.attemptResult) {
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM public.defect_inspection_attempts attempt
      WHERE attempt."defectItemId" = d.id
        AND attempt.status::text = ${query.attemptResult}
    )`);
  }
  if (metric) {
    parts.push(metricSql(metric, query));
  }
  return Prisma.join(parts, ' AND ');
}

function organizationScopeSql(organizationIds: readonly string[]): Prisma.Sql {
  if (organizationIds.length === 0) {
    return Prisma.sql`FALSE`;
  }
  const ids = organizationIds.map((id) => Prisma.sql`${id}::uuid`);
  return Prisma.sql`EXISTS (
    SELECT 1 FROM public.defect_item_liable_organizations liable
    WHERE liable."defectItemId" = d.id
      AND liable."organizationId" IN (${Prisma.join(ids)})
  )`;
}

function importedSql(): Prisma.Sql {
  return Prisma.sql`(d."importBatchId" IS NOT NULL OR d."sourceSystem" IS NOT NULL)`;
}

function metricSql(metric: AnalyticsMetric, query: AnalyticsQuery): Prisma.Sql {
  switch (metric) {
    case 'defects':
    case 'acts':
      return Prisma.sql`TRUE`;
    case 'openDefects':
      return Prisma.sql`d.status::text IN ('IN_PROGRESS', 'PENDING_INSPECTION')`;
    case 'overdueDefects':
      return Prisma.sql`d.status::text <> 'COMPLETED' AND d."effectiveDeadline" IS NOT NULL AND d."effectiveDeadline" < now()`;
    case 'noResponsible':
      return Prisma.sql`NOT EXISTS (
        SELECT 1 FROM public.defect_item_engineers engineer
        WHERE engineer."defectItemId" = d.id
      )`;
    case 'noLiableOrganization':
      return Prisma.sql`NOT EXISTS (
        SELECT 1 FROM public.defect_item_liable_organizations liable
        WHERE liable."defectItemId" = d.id
      )`;
    case 'noMovement':
      return Prisma.sql`d.status::text = 'IN_PROGRESS' AND d."updatedAt" < now() - make_interval(days => ${ANALYTICS_NO_MOVEMENT_DAYS})`;
    case 'closedInPeriod':
      return Prisma.join(
        [
          Prisma.sql`d.status::text = 'COMPLETED'`,
          query.dateFrom
            ? Prisma.sql`d."readyAt" >= ${minskDayStart(query.dateFrom)}`
            : Prisma.sql`TRUE`,
          query.dateTo ? Prisma.sql`d."readyAt" <= ${minskDayEnd(query.dateTo)}` : Prisma.sql`TRUE`,
        ],
        ' AND ',
      );
    case 'companyActualCost':
      return Prisma.sql`EXISTS (
        SELECT 1 FROM public.defect_financial_impacts impact
        WHERE impact."defectItemId" = d.id
          AND impact.status::text = 'CONFIRMED'
          AND impact."amountType"::text = 'ACTUAL_COST'
          AND impact."payerType"::text = 'COMPANY'
      )`;
    case 'liableActualCost':
      return Prisma.sql`EXISTS (
        SELECT 1 FROM public.defect_financial_impacts impact
        WHERE impact."defectItemId" = d.id
          AND impact.status::text = 'CONFIRMED'
          AND impact."amountType"::text = 'ACTUAL_COST'
          AND impact."payerType"::text = 'LIABLE_ORGANIZATION'
      )`;
    case 'recovery':
      return Prisma.sql`EXISTS (
        SELECT 1 FROM public.defect_financial_impacts impact
        WHERE impact."defectItemId" = d.id
          AND impact.status::text = 'CONFIRMED'
          AND impact."amountType"::text = 'RECOVERY'
      )`;
    case 'avoidedLoss':
      return Prisma.sql`EXISTS (
        SELECT 1 FROM public.defect_financial_impacts impact
        WHERE impact."defectItemId" = d.id
          AND impact.status::text = 'CONFIRMED'
          AND impact."amountType"::text = 'AVOIDED_LOSS'
      )`;
    case 'reworkCost':
      return Prisma.sql`EXISTS (
        SELECT 1 FROM public.defect_financial_impacts impact
        WHERE impact."defectItemId" = d.id
          AND impact.status::text = 'CONFIRMED'
          AND impact."amountType"::text = 'ACTUAL_COST'
          AND impact."payerType"::text = 'COMPANY'
      ) AND EXISTS (
        SELECT 1 FROM public.defect_inspection_attempts attempt
        WHERE attempt."defectItemId" = d.id
          AND (attempt."attemptNumber" > 1 OR attempt.status::text = 'REJECTED')
      )`;
    case 'firstTimeRight':
      return Prisma.sql`d.status::text = 'COMPLETED' AND EXISTS (
        SELECT 1 FROM public.defect_inspection_attempts attempt
        WHERE attempt."defectItemId" = d.id
          AND attempt.status::text = 'ACCEPTED'
          AND attempt."attemptNumber" = 1
      )`;
    case 'rework':
      return Prisma.sql`d.status::text = 'COMPLETED' AND EXISTS (
        SELECT 1 FROM public.defect_inspection_attempts attempt
        WHERE attempt."defectItemId" = d.id
          AND attempt.status::text = 'REJECTED'
      )`;
    case 'withAttempts':
      return Prisma.sql`EXISTS (
        SELECT 1 FROM public.defect_inspection_attempts attempt
        WHERE attempt."defectItemId" = d.id
      )`;
    case 'withoutAttempts':
      return Prisma.sql`NOT EXISTS (
        SELECT 1 FROM public.defect_inspection_attempts attempt
        WHERE attempt."defectItemId" = d.id
      )`;
    default:
      return Prisma.sql`TRUE`;
  }
}

export function scopedFrom(where: Prisma.Sql, joins: Prisma.Sql = Prisma.empty): Prisma.Sql {
  return Prisma.sql`
    FROM public.defect_items d
    JOIN public.acts a ON a.id = d."actId"
    ${joins}
    WHERE ${where}
  `;
}
