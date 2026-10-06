import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';
import { ANALYTICS_INSPECTION_WAIT_DAYS, ANALYTICS_TOP_RISK_LIMIT } from '@sgr-registry/domain';

export function statementFingerprint(sql: Prisma.Sql): string {
  const query = sql as Prisma.Sql & { strings: readonly string[] };
  return createHash('sha256').update(query.strings.join('$?')).digest('hex');
}

export function explainStatement(sql: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`;
}

function analyticsScopeIsMaterialized(): boolean {
  const storage = (globalThis as Record<symbol, AsyncLocalStorage<true> | undefined>)[
    Symbol.for('sgr.analytics.materialized-scope')
  ];
  return storage?.getStore() === true;
}

function scopedFrom(where: Prisma.Sql, joins: Prisma.Sql = Prisma.empty): Prisma.Sql {
  if (analyticsScopeIsMaterialized()) {
    return Prisma.sql`
      FROM analytics_scope_defects d
      JOIN public.acts a ON a.id = d."actId"
      ${joins}
      WHERE ${where}
    `;
  }
  return Prisma.sql`
    FROM public.defect_items d
    JOIN public.acts a ON a.id = d."actId"
    ${joins}
    WHERE ${where}
  `;
}

export const invalidTemporalPredicate = Prisma.sql`(
  (d."readyAt" IS NOT NULL AND d."readyAt" < d."createdAt")
  OR (d."submittedForInspectionAt" IS NOT NULL AND d."submittedForInspectionAt" < d."createdAt")
  OR (d."acceptedAt" IS NOT NULL AND d."acceptedAt" < d."createdAt")
  OR (d."rejectedAt" IS NOT NULL AND d."rejectedAt" < d."createdAt")
  OR (
    d."acceptedAt" IS NOT NULL
    AND d."submittedForInspectionAt" IS NOT NULL
    AND d."acceptedAt" < d."submittedForInspectionAt"
  )
  OR EXISTS (
    SELECT 1 FROM public.defect_inspection_attempts attempt
    WHERE attempt."defectItemId" = d.id
      AND (
        attempt."submittedAt" < d."createdAt"
        OR (attempt."reviewedAt" IS NOT NULL AND attempt."reviewedAt" < attempt."submittedAt")
      )
  )
)`;

export function overviewCountsSql(where: Prisma.Sql, closureWindow: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT
      count(DISTINCT a.id)::int AS acts,
      count(*)::int AS defects,
      count(*) FILTER (WHERE d.status::text IN ('IN_PROGRESS', 'PENDING_INSPECTION'))::int AS open_defects,
      count(*) FILTER (WHERE d.status::text <> 'COMPLETED' AND d."effectiveDeadline" IS NOT NULL AND d."effectiveDeadline" < now())::int AS overdue_defects,
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.defect_item_engineers engineer WHERE engineer."defectItemId" = d.id))::int AS no_responsible,
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.defect_item_liable_organizations liable WHERE liable."defectItemId" = d.id))::int AS no_liable,
      count(*) FILTER (WHERE d.status::text = 'IN_PROGRESS' AND d."updatedAt" < now() - make_interval(days => 14))::int AS no_movement,
      count(*) FILTER (WHERE d.status::text = 'COMPLETED' ${closureWindow})::int AS closed_in_period
    ${scopedFrom(where)}
  `;
}

export function overviewClosureSql(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (d."readyAt" - d."createdAt")) * 1000) AS median,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (d."readyAt" - d."createdAt")) * 1000) AS p90,
      count(*)::int AS sample
    ${scopedFrom(where)}
    AND d.status::text = 'COMPLETED'
    AND d."readyAt" IS NOT NULL
    AND d."readyAt" >= d."createdAt"
  `;
}

function insightMatch(
  scopeFingerprint: string,
  where: Prisma.Sql,
  status: 'NEW' | null,
  excludedTypes: readonly string[],
): Prisma.Sql {
  const statusSql = status ? Prisma.sql`AND insight.status::text = ${status}` : Prisma.empty;
  const excludedSql =
    excludedTypes.length > 0
      ? Prisma.sql`AND insight."signalType"::text NOT IN (${Prisma.join(excludedTypes)})`
      : Prisma.empty;
  if (analyticsScopeIsMaterialized()) {
    return Prisma.sql`
      FROM public.analytics_insights insight
      WHERE insight."scopeFingerprint" = ${scopeFingerprint}
        AND insight.active = true
        AND insight."supportAvailable" = true
        ${statusSql}
        ${excludedSql}
        AND public.sgr_insight_intersects_scope(insight.id)
    `;
  }
  return Prisma.sql`
    FROM public.analytics_insights insight
    JOIN LATERAL (
      SELECT 1
      FROM public.analytics_insight_defects link
      JOIN public.defect_items d ON d.id = link."defectItemId"
      JOIN public.acts a ON a.id = d."actId"
      WHERE link."insightId" = insight.id
        AND ${where}
      LIMIT 1
    ) matched ON true
    WHERE insight."scopeFingerprint" = ${scopeFingerprint}
      AND insight.active = true
      AND insight."supportAvailable" = true
      ${statusSql}
      ${excludedSql}
  `;
}

export function newInsightsCountSql(
  scopeFingerprint: string,
  where: Prisma.Sql,
  excludedTypes: readonly string[] = [],
): Prisma.Sql {
  return Prisma.sql`
    SELECT count(DISTINCT insight.id)::int AS n
    ${insightMatch(scopeFingerprint, where, 'NEW', excludedTypes)}
  `;
}

export function matchingInsightIdsSql(
  scopeFingerprint: string,
  where: Prisma.Sql,
  excludedTypes: readonly string[] = [],
): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT insight.id::text AS id
    ${insightMatch(scopeFingerprint, where, null, excludedTypes)}
  `;
}

export function processClocksSql(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    WITH attempts AS (
      SELECT attempt."defectItemId", attempt."attemptNumber", attempt."submittedAt", attempt."reviewedAt",
             lag(attempt."reviewedAt") OVER (PARTITION BY attempt."defectItemId" ORDER BY attempt."attemptNumber") AS prev_reviewed
      FROM public.defect_inspection_attempts attempt
    ),
    samples AS (
      SELECT
        CASE
          WHEN attempts."attemptNumber" = 1
            AND attempts."submittedAt" >= d."createdAt"
            AND attempts."submittedAt" >= COALESCE(a."startedAt", d."createdAt")
            THEN EXTRACT(EPOCH FROM (attempts."submittedAt" - COALESCE(a."startedAt", d."createdAt"))) * 1000
          WHEN attempts."attemptNumber" > 1
            AND attempts.prev_reviewed IS NOT NULL
            AND attempts."submittedAt" >= d."createdAt"
            AND attempts."submittedAt" >= attempts.prev_reviewed
            THEN EXTRACT(EPOCH FROM (attempts."submittedAt" - attempts.prev_reviewed)) * 1000
          ELSE NULL
        END AS contractor_ms,
        CASE
          WHEN attempts."reviewedAt" IS NOT NULL
            AND attempts."submittedAt" >= d."createdAt"
            AND attempts."reviewedAt" >= attempts."submittedAt"
            THEN EXTRACT(EPOCH FROM (attempts."reviewedAt" - attempts."submittedAt")) * 1000
          ELSE NULL
        END AS inspection_ms,
        CASE
          WHEN attempts."attemptNumber" > 1
            AND attempts.prev_reviewed IS NOT NULL
            AND attempts."submittedAt" >= d."createdAt"
            AND attempts."submittedAt" >= attempts.prev_reviewed
            THEN EXTRACT(EPOCH FROM (attempts."submittedAt" - attempts.prev_reviewed)) * 1000
          ELSE NULL
        END AS rework_ms,
        CASE
          WHEN d.status::text = 'COMPLETED'
            AND d."readyAt" IS NOT NULL
            AND d."readyAt" >= d."createdAt"
            THEN EXTRACT(EPOCH FROM (d."readyAt" - d."createdAt")) * 1000
          ELSE NULL
        END AS total_ms
      ${scopedFrom(where, Prisma.sql`JOIN attempts ON attempts."defectItemId" = d.id`)}
    )
    SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY contractor_ms) AS contractor_median,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY contractor_ms) AS contractor_p75,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY contractor_ms) AS contractor_p90,
      min(contractor_ms) AS contractor_min,
      max(contractor_ms) AS contractor_max,
      avg(contractor_ms) AS contractor_mean,
      count(contractor_ms)::int AS contractor_sample,
      count(*)::int AS contractor_population,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY inspection_ms) AS inspection_median,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY inspection_ms) AS inspection_p75,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY inspection_ms) AS inspection_p90,
      min(inspection_ms) AS inspection_min,
      max(inspection_ms) AS inspection_max,
      avg(inspection_ms) AS inspection_mean,
      count(inspection_ms)::int AS inspection_sample,
      count(*)::int AS inspection_population,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY rework_ms) AS rework_median,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY rework_ms) AS rework_p75,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY rework_ms) AS rework_p90,
      min(rework_ms) AS rework_min,
      max(rework_ms) AS rework_max,
      avg(rework_ms) AS rework_mean,
      count(rework_ms)::int AS rework_sample,
      count(*)::int AS rework_population,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS total_median,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY total_ms) AS total_p75,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY total_ms) AS total_p90,
      min(total_ms) AS total_min,
      max(total_ms) AS total_max,
      avg(total_ms) AS total_mean,
      count(total_ms)::int AS total_sample,
      count(*)::int AS total_population
    FROM samples
  `;
}

export function topRisksSql(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    WITH population AS MATERIALIZED (
      SELECT d.id, d."defectTypeId", d.status::text AS status, d."createdAt", d."effectiveDeadline",
             a.id AS act_id, coalesce(d.location, dt.name) AS label
      ${scopedFrom(where, Prisma.sql`JOIN public.defect_types dt ON dt.id = d."defectTypeId"`)}
    ),
    type_counts AS (
      SELECT "defectTypeId", count(*)::int AS type_count
      FROM population
      GROUP BY "defectTypeId"
    ),
    open_defects AS (
      SELECT id, act_id, label, "createdAt", "effectiveDeadline", "defectTypeId"
      FROM population
      WHERE status <> 'COMPLETED'
    ),
    attempts AS (
      SELECT attempt."defectItemId" AS id,
             count(*) FILTER (WHERE attempt.status::text = 'REJECTED')::int AS rejections,
             count(*)::int AS attempt_count
      FROM public.defect_inspection_attempts attempt
      JOIN open_defects ON open_defects.id = attempt."defectItemId"
      GROUP BY attempt."defectItemId"
    ),
    costs AS (
      SELECT impact."defectItemId" AS id, sum(impact."amountByn") AS cost
      FROM public.defect_financial_impacts impact
      JOIN open_defects ON open_defects.id = impact."defectItemId"
      WHERE impact.status::text = 'CONFIRMED'
        AND impact."amountType"::text = 'ACTUAL_COST'
        AND impact."payerType"::text = 'COMPANY'
      GROUP BY impact."defectItemId"
    ),
    liable AS (
      SELECT DISTINCT link."defectItemId" AS id
      FROM public.defect_item_liable_organizations link
      JOIN open_defects ON open_defects.id = link."defectItemId"
    ),
    engineers AS (
      SELECT DISTINCT engineer."defectItemId" AS id
      FROM public.defect_item_engineers engineer
      JOIN open_defects ON open_defects.id = engineer."defectItemId"
    )
    SELECT ranked.id, ranked.act_id, ranked.label, ranked.score::text AS score
    FROM (
      SELECT open_defects.id::text AS id,
             open_defects.act_id::text AS act_id,
             open_defects.label,
             round((
               LEAST(3, EXTRACT(EPOCH FROM (now() - open_defects."createdAt")) / 86400 / 30)
               + CASE
                   WHEN open_defects."effectiveDeadline" IS NULL THEN 0
                   WHEN open_defects."effectiveDeadline" < now() THEN 2
                   ELSE 0
                 END
               + CASE
                   WHEN attempts.attempt_count IS NULL THEN 0
                   ELSE LEAST(3, attempts.rejections)
                 END
               + CASE WHEN liable.id IS NULL THEN 1 ELSE 0 END
               + CASE WHEN engineers.id IS NULL THEN 1 ELSE 0 END
               + CASE
                   WHEN costs.cost IS NOT NULL AND costs.cost > 0
                   THEN LEAST(3, log(10, costs.cost + 1))
                   ELSE 0
                 END
               + CASE WHEN coalesce(type_counts.type_count, 0) >= 3 THEN 1 ELSE 0 END
             )::numeric, 4) AS score
      FROM open_defects
      LEFT JOIN attempts ON attempts.id = open_defects.id
      LEFT JOIN costs ON costs.id = open_defects.id
      LEFT JOIN type_counts ON type_counts."defectTypeId" = open_defects."defectTypeId"
      LEFT JOIN liable ON liable.id = open_defects.id
      LEFT JOIN engineers ON engineers.id = open_defects.id
    ) ranked
    ORDER BY ranked.score DESC, ranked.id ASC
    LIMIT ${ANALYTICS_TOP_RISK_LIMIT}
  `;
}

export function confirmedExposureSql(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT
      sum(impact."amountByn") FILTER (
        WHERE impact.status::text = 'CONFIRMED'
          AND impact."amountType"::text = 'ACTUAL_COST'
          AND impact."payerType"::text = 'COMPANY'
      )::text AS gross,
      sum(impact."amountByn") FILTER (
        WHERE impact.status::text = 'CONFIRMED'
          AND impact."amountType"::text = 'RECOVERY'
      )::text AS recovery,
      count(*) FILTER (
        WHERE impact.status::text = 'CONFIRMED'
          AND (
            (impact."amountType"::text = 'ACTUAL_COST' AND impact."payerType"::text = 'COMPANY')
            OR impact."amountType"::text = 'RECOVERY'
          )
      )::int AS records
    ${scopedFrom(
      where,
      Prisma.sql`JOIN public.defect_financial_impacts impact ON impact."defectItemId" = d.id`,
    )}
  `;
}

export function riskWeightedBacklogSql(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    WITH open_defects AS (
      SELECT d.id, d.status::text AS status, d."effectiveDeadline" AS deadline
      ${scopedFrom(where)}
      AND d.status::text IN ('IN_PROGRESS', 'PENDING_INSPECTION')
    ),
    approved AS (
      SELECT DISTINCT ON (impact."defectItemId") impact."defectItemId" AS id, impact."amountByn" AS amount
      FROM public.defect_financial_impacts impact
      WHERE impact.status::text = 'CONFIRMED' AND impact."amountType"::text = 'APPROVED_AMOUNT'
      ORDER BY impact."defectItemId", impact."occurredAt" DESC, impact.id DESC
    ),
    estimate AS (
      SELECT DISTINCT ON (impact."defectItemId") impact."defectItemId" AS id, impact."amountByn" AS amount
      FROM public.defect_financial_impacts impact
      WHERE impact.status::text = 'CONFIRMED' AND impact."amountType"::text = 'ESTIMATE'
      ORDER BY impact."defectItemId", impact."occurredAt" DESC, impact.id DESC
    ),
    attempts AS (
      SELECT attempt."defectItemId" AS id,
             count(*) FILTER (WHERE attempt.status::text = 'REJECTED')::int AS rejections,
             bool_or(
               attempt.status::text = 'PENDING'
               AND attempt."submittedAt" < now() - make_interval(days => ${ANALYTICS_INSPECTION_WAIT_DAYS})
             ) AS waiting
      FROM public.defect_inspection_attempts attempt
      GROUP BY attempt."defectItemId"
    ),
    priced AS (
      SELECT open_defects.id,
             coalesce(approved.amount, estimate.amount) AS base_amount,
             LEAST(
               2.00,
               1.00
               + CASE WHEN open_defects.deadline IS NOT NULL AND open_defects.deadline < now() THEN 0.25 ELSE 0 END
               + 0.15 * GREATEST(coalesce(attempts.rejections, 0) - 1, 0)
               + CASE
                   WHEN open_defects.status = 'PENDING_INSPECTION' AND coalesce(attempts.waiting, false)
                   THEN 0.20 ELSE 0
                 END
             ) AS coefficient
      FROM open_defects
      LEFT JOIN approved ON approved.id = open_defects.id
      LEFT JOIN estimate ON estimate.id = open_defects.id
      LEFT JOIN attempts ON attempts.id = open_defects.id
    )
    SELECT (SELECT count(*)::int FROM open_defects) AS open_count,
           count(base_amount)::int AS evaluated,
           sum(base_amount)::text AS unweighted,
           sum(round(base_amount * coefficient, 2))::text AS weighted
    FROM priced
  `;
}

export function lowFirstTimeRightSql(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    WITH scoped AS (
      SELECT d.id, d.status::text AS status, d."defectTypeId" AS type_id, dt.name AS type_name,
             d."workTypeId" AS work_id, wt.name AS work_name,
             a."objectId" AS object_id, po.name AS object_name
      ${scopedFrom(
        where,
        Prisma.sql`JOIN public.defect_types dt ON dt.id = d."defectTypeId"
          JOIN public.property_objects po ON po.id = a."objectId"
          LEFT JOIN public.work_types wt ON wt.id = d."workTypeId"`,
      )}
    ),
    flags AS (
      SELECT attempt."defectItemId" AS id,
             bool_or(attempt.status::text = 'ACCEPTED' AND attempt."attemptNumber" = 1) AS first_accept
      FROM public.defect_inspection_attempts attempt
      JOIN scoped ON scoped.id = attempt."defectItemId"
      GROUP BY attempt."defectItemId"
    ),
    base AS (
      SELECT count(*) FILTER (WHERE scoped.status = 'COMPLETED' AND flags.id IS NOT NULL)::int AS with_attempts,
             count(*) FILTER (WHERE scoped.status = 'COMPLETED' AND flags.first_accept)::int AS first_accept,
             count(*) FILTER (WHERE scoped.status = 'COMPLETED')::int AS completed
      FROM scoped
      LEFT JOIN flags ON flags.id = scoped.id
    )
    SELECT * FROM (
      SELECT 'liableOrganization' AS dim_key, org.id::text AS dim_id, org."officialName" AS dim_label,
             count(*) FILTER (WHERE scoped.status = 'COMPLETED' AND flags.id IS NOT NULL)::int AS support,
             count(*) FILTER (WHERE scoped.status = 'COMPLETED' AND flags.first_accept)::int AS positive,
             count(*) FILTER (WHERE scoped.status = 'COMPLETED')::int AS completed,
             max(base.with_attempts)::int AS baseline_total,
             max(base.first_accept)::int AS baseline_positive,
             max(base.completed)::int AS baseline_completed
      FROM scoped
      LEFT JOIN flags ON flags.id = scoped.id
      JOIN public.defect_item_liable_organizations link ON link."defectItemId" = scoped.id
      JOIN public.organizations org ON org.id = link."organizationId"
      CROSS JOIN base
      GROUP BY org.id, org."officialName"
      UNION ALL
      SELECT 'defectType', type_id::text, type_name,
             count(*) FILTER (WHERE status = 'COMPLETED' AND flags.id IS NOT NULL)::int,
             count(*) FILTER (WHERE status = 'COMPLETED' AND flags.first_accept)::int,
             count(*) FILTER (WHERE status = 'COMPLETED')::int,
             max(base.with_attempts)::int, max(base.first_accept)::int, max(base.completed)::int
      FROM scoped
      LEFT JOIN flags ON flags.id = scoped.id
      CROSS JOIN base
      GROUP BY type_id, type_name
      UNION ALL
      SELECT 'workType', work_id::text, work_name,
             count(*) FILTER (WHERE status = 'COMPLETED' AND flags.id IS NOT NULL)::int,
             count(*) FILTER (WHERE status = 'COMPLETED' AND flags.first_accept)::int,
             count(*) FILTER (WHERE status = 'COMPLETED')::int,
             max(base.with_attempts)::int, max(base.first_accept)::int, max(base.completed)::int
      FROM scoped
      LEFT JOIN flags ON flags.id = scoped.id
      CROSS JOIN base
      WHERE work_id IS NOT NULL AND work_name IS NOT NULL
      GROUP BY work_id, work_name
      UNION ALL
      SELECT 'propertyObject', object_id::text, object_name,
             count(*) FILTER (WHERE status = 'COMPLETED' AND flags.id IS NOT NULL)::int,
             count(*) FILTER (WHERE status = 'COMPLETED' AND flags.first_accept)::int,
             count(*) FILTER (WHERE status = 'COMPLETED')::int,
             max(base.with_attempts)::int, max(base.first_accept)::int, max(base.completed)::int
      FROM scoped
      LEFT JOIN flags ON flags.id = scoped.id
      CROSS JOIN base
      GROUP BY object_id, object_name
    ) segments
    WHERE support >= 5
    LIMIT 40
  `;
}

export function supportDrilldownSql(input: {
  insightId: string;
  where: Prisma.Sql;
  order: Prisma.Sql;
  direction: Prisma.Sql;
  pageSize: number;
  offset: number;
  includeOrganizations: boolean;
}): Prisma.Sql {
  const organizations = input.includeOrganizations
    ? Prisma.sql`(
        SELECT string_agg(org."officialName", ', ' ORDER BY org."officialName")
        FROM public.defect_item_liable_organizations liable
        JOIN public.organizations org ON org.id = liable."organizationId"
        WHERE liable."defectItemId" = d.id
      )`
    : Prisma.sql`NULL::text`;
  return Prisma.sql`
    SELECT d.id::text AS defect_id,
           coalesce(nullif(d.location, ''), dt.name) AS label,
           a.id::text AS act_id,
           a."officialNumber" AS act_number,
           po.name AS object_name,
           dt.name AS defect_type,
           wt.name AS work_type,
           ${organizations} AS orgs,
           d.status::text AS status,
           d."effectiveDeadline" AS deadline,
           (
             SELECT count(*)::int FROM public.defect_inspection_attempts attempt
             WHERE attempt."defectItemId" = d.id
           ) AS attempts,
           link."contributionReason" AS reason
    FROM public.analytics_insight_defects link
    JOIN public.defect_items d ON d.id = link."defectItemId"
    JOIN public.acts a ON a.id = d."actId"
    JOIN public.property_objects po ON po.id = a."objectId"
    JOIN public.defect_types dt ON dt.id = d."defectTypeId"
    LEFT JOIN public.work_types wt ON wt.id = d."workTypeId"
    WHERE link."insightId" = ${input.insightId}::uuid
      AND ${input.where}
    ORDER BY ${input.order} ${input.direction}, d.id ASC
    LIMIT ${input.pageSize} OFFSET ${input.offset}
  `;
}

export function invalidTemporalCountSql(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS n
    ${scopedFrom(where)}
    AND ${invalidTemporalPredicate}
  `;
}

export function dropAnalyticsScopeSql(): Prisma.Sql {
  return Prisma.sql`DROP TABLE IF EXISTS analytics_scope_defects`;
}

export function materializeAnalyticsScopeSql(where: Prisma.Sql, staff = false): Prisma.Sql {
  if (staff) {
    return Prisma.sql`
      CREATE TEMP TABLE analytics_scope_defects ON COMMIT DROP AS
      SELECT d.id, d."actId", d.status, d."createdAt", d."updatedAt", d."readyAt",
             d."effectiveDeadline", d."defectTypeId", d."workTypeId", d.location,
             d."submittedForInspectionAt", d."acceptedAt", d."rejectedAt",
             d."importBatchId", d."sourceSystem"
      FROM public.sgr_staff_defect_items() d
      CROSS JOIN LATERAL (
        SELECT d."actId" AS id,
               d."actObjectId" AS "objectId",
               d."actCustomerOrganizationId" AS "customerOrganizationId",
               d."actStatus" AS status
      ) a
      WHERE ${where}
    `;
  }
  return Prisma.sql`
    CREATE TEMP TABLE analytics_scope_defects ON COMMIT DROP AS
    SELECT d.id, d."actId", d.status, d."createdAt", d."updatedAt", d."readyAt",
           d."effectiveDeadline", d."defectTypeId", d."workTypeId", d.location,
           d."submittedForInspectionAt", d."acceptedAt", d."rejectedAt",
           d."importBatchId", d."sourceSystem"
    FROM public.defect_items d
    JOIN public.acts a ON a.id = d."actId"
    WHERE ${where}
  `;
}

export function indexAnalyticsScopeSql(): Prisma.Sql {
  return Prisma.sql`
    CREATE INDEX analytics_scope_defects_id_idx ON analytics_scope_defects (id)
  `;
}

export function overviewBundleSql(input: {
  closureFrom: Date | null;
  closureTo: Date | null;
  scopeFingerprint: string;
  excludedTypes: readonly string[];
  financial: boolean;
  crossOrganization: boolean;
}): Prisma.Sql {
  const closureFrom = input.closureFrom
    ? Prisma.sql`AND fd."readyAt" >= ${input.closureFrom}`
    : Prisma.empty;
  const closureTo = input.closureTo
    ? Prisma.sql`AND fd."readyAt" <= ${input.closureTo}`
    : Prisma.empty;
  const excluded =
    input.excludedTypes.length > 0
      ? Prisma.sql`AND insight."signalType"::text NOT IN (${Prisma.join(input.excludedTypes)})`
      : Prisma.empty;
  const topOrganizations =
    input.financial && input.crossOrganization
      ? Prisma.sql`(
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', org_row.id, 'name', org_row.name, 'amount', org_row.amount
        ) ORDER BY org_row.sort_amount DESC, org_row.id ASC), '[]'::jsonb)
        FROM (
          SELECT org.id::text AS id, org."officialName" AS name,
                 sum(impact."amountByn")::text AS amount,
                 sum(impact."amountByn") AS sort_amount
          FROM filtered fd
          JOIN public.defect_financial_impacts impact ON impact."defectItemId" = fd.id
            AND impact.status::text = 'CONFIRMED'
            AND impact."amountType"::text = 'ACTUAL_COST'
            AND impact."payerType"::text = 'COMPANY'
          JOIN public.defect_item_liable_organizations link ON link."defectItemId" = fd.id
          JOIN public.organizations org ON org.id = link."organizationId"
          GROUP BY org.id, org."officialName"
          ORDER BY sum(impact."amountByn") DESC, org.id ASC
          LIMIT 5
        ) org_row
      )`
      : Prisma.sql`'[]'::jsonb`;
  const companyCost = input.financial
    ? Prisma.sql`(SELECT sum(company_cost)::text FROM money)`
    : Prisma.sql`NULL::text`;
  const exposureGross = input.financial
    ? Prisma.sql`(SELECT gross FROM exposure)`
    : Prisma.sql`NULL::text`;
  const exposureRecovery = input.financial
    ? Prisma.sql`(SELECT recovery FROM exposure)`
    : Prisma.sql`NULL::text`;
  const exposureRecords = input.financial
    ? Prisma.sql`(SELECT records FROM exposure)`
    : Prisma.sql`0`;
  const backlogOpen = input.financial
    ? Prisma.sql`(SELECT open_count FROM backlog)`
    : Prisma.sql`0`;
  const backlogEvaluated = input.financial
    ? Prisma.sql`(SELECT evaluated FROM backlog)`
    : Prisma.sql`0`;
  const backlogUnweighted = input.financial
    ? Prisma.sql`(SELECT unweighted FROM backlog)`
    : Prisma.sql`NULL::text`;
  const backlogWeighted = input.financial
    ? Prisma.sql`(SELECT weighted FROM backlog)`
    : Prisma.sql`NULL::text`;
  return Prisma.sql`
    WITH filtered AS MATERIALIZED (
      SELECT fd.id, fd."actId", fd.status::text AS status, fd."createdAt", fd."updatedAt", fd."readyAt",
             fd."effectiveDeadline", fd."defectTypeId", fd."workTypeId", fd.location,
             fd."submittedForInspectionAt", fd."acceptedAt", fd."rejectedAt",
             dt.name AS type_name
      FROM analytics_scope_defects fd
      JOIN public.defect_types dt ON dt.id = fd."defectTypeId"
    ),
    attempt_flags AS (
      SELECT attempt."defectItemId" AS id,
             count(*)::int AS attempt_count,
             count(*) FILTER (WHERE attempt.status::text = 'REJECTED')::int AS rejections,
             bool_or(attempt.status::text = 'ACCEPTED' AND attempt."attemptNumber" = 1) AS accepted_first,
             bool_or(
               attempt.status::text = 'PENDING'
               AND attempt."submittedAt" < now() - make_interval(days => ${ANALYTICS_INSPECTION_WAIT_DAYS})
             ) AS waiting,
             bool_or(
               attempt."submittedAt" < fd."createdAt"
               OR (attempt."reviewedAt" IS NOT NULL AND attempt."reviewedAt" < attempt."submittedAt")
             ) AS temporal_invalid
      FROM public.defect_inspection_attempts attempt
      JOIN filtered fd ON fd.id = attempt."defectItemId"
      GROUP BY attempt."defectItemId"
    ),
    engineer_ids AS (
      SELECT DISTINCT engineer."defectItemId" AS id
      FROM public.defect_item_engineers engineer
      JOIN filtered fd ON fd.id = engineer."defectItemId"
    ),
    liable_ids AS (
      SELECT DISTINCT link."defectItemId" AS id
      FROM public.defect_item_liable_organizations link
      JOIN filtered fd ON fd.id = link."defectItemId"
    ),
    money AS (
      SELECT impact."defectItemId" AS id,
             sum(impact."amountByn") FILTER (
               WHERE impact.status::text = 'CONFIRMED'
                 AND impact."amountType"::text = 'ACTUAL_COST'
                 AND impact."payerType"::text = 'COMPANY'
             ) AS company_cost
      FROM public.defect_financial_impacts impact
      JOIN filtered fd ON fd.id = impact."defectItemId"
      GROUP BY impact."defectItemId"
    ),
    exposure AS (
      SELECT
        sum(impact."amountByn") FILTER (
          WHERE impact.status::text = 'CONFIRMED'
            AND impact."amountType"::text = 'ACTUAL_COST'
            AND impact."payerType"::text = 'COMPANY'
        )::text AS gross,
        sum(impact."amountByn") FILTER (
          WHERE impact.status::text = 'CONFIRMED' AND impact."amountType"::text = 'RECOVERY'
        )::text AS recovery,
        count(*) FILTER (
          WHERE impact.status::text = 'CONFIRMED'
            AND (
              (impact."amountType"::text = 'ACTUAL_COST' AND impact."payerType"::text = 'COMPANY')
              OR impact."amountType"::text = 'RECOVERY'
            )
        )::int AS records
      FROM public.defect_financial_impacts impact
      JOIN filtered fd ON fd.id = impact."defectItemId"
    ),
    approved AS (
      SELECT DISTINCT ON (impact."defectItemId") impact."defectItemId" AS id, impact."amountByn" AS amount
      FROM public.defect_financial_impacts impact
      JOIN filtered fd ON fd.id = impact."defectItemId"
      WHERE impact.status::text = 'CONFIRMED' AND impact."amountType"::text = 'APPROVED_AMOUNT'
        AND fd.status IN ('IN_PROGRESS', 'PENDING_INSPECTION')
      ORDER BY impact."defectItemId", impact."occurredAt" DESC, impact.id DESC
    ),
    estimate AS (
      SELECT DISTINCT ON (impact."defectItemId") impact."defectItemId" AS id, impact."amountByn" AS amount
      FROM public.defect_financial_impacts impact
      JOIN filtered fd ON fd.id = impact."defectItemId"
      WHERE impact.status::text = 'CONFIRMED' AND impact."amountType"::text = 'ESTIMATE'
        AND fd.status IN ('IN_PROGRESS', 'PENDING_INSPECTION')
      ORDER BY impact."defectItemId", impact."occurredAt" DESC, impact.id DESC
    ),
    type_counts AS (
      SELECT "defectTypeId", count(*)::int AS type_count
      FROM filtered
      GROUP BY "defectTypeId"
    ),
    backlog AS (
      SELECT count(*)::int AS open_count,
             count(base_amount)::int AS evaluated,
             sum(base_amount)::text AS unweighted,
             sum(round(base_amount * coefficient, 2))::text AS weighted
      FROM (
        SELECT coalesce(approved.amount, estimate.amount) AS base_amount,
               LEAST(
                 2.00,
                 1.00
                 + CASE WHEN fd."effectiveDeadline" IS NOT NULL AND fd."effectiveDeadline" < now() THEN 0.25 ELSE 0 END
                 + 0.15 * GREATEST(coalesce(attempt_flags.rejections, 0) - 1, 0)
                 + CASE
                     WHEN fd.status = 'PENDING_INSPECTION' AND coalesce(attempt_flags.waiting, false)
                     THEN 0.20 ELSE 0
                   END
               ) AS coefficient
        FROM filtered fd
        LEFT JOIN approved ON approved.id = fd.id
        LEFT JOIN estimate ON estimate.id = fd.id
        LEFT JOIN attempt_flags ON attempt_flags.id = fd.id
        WHERE fd.status IN ('IN_PROGRESS', 'PENDING_INSPECTION')
      ) priced
    ),
    ranked AS (
      SELECT fd.id::text AS id,
             fd."actId"::text AS act_id,
             coalesce(fd.location, fd.type_name) AS label,
             round((
               LEAST(3, EXTRACT(EPOCH FROM (now() - fd."createdAt")) / 86400 / 30)
               + CASE
                   WHEN fd."effectiveDeadline" IS NULL THEN 0
                   WHEN fd."effectiveDeadline" < now() THEN 2
                   ELSE 0
                 END
               + CASE
                   WHEN attempt_flags.attempt_count IS NULL THEN 0
                   ELSE LEAST(3, attempt_flags.rejections)
                 END
               + CASE WHEN liable_ids.id IS NULL THEN 1 ELSE 0 END
               + CASE WHEN engineer_ids.id IS NULL THEN 1 ELSE 0 END
               + CASE
                   WHEN money.company_cost IS NOT NULL AND money.company_cost > 0
                   THEN LEAST(3, log(10, money.company_cost + 1))
                   ELSE 0
                 END
               + CASE WHEN coalesce(type_counts.type_count, 0) >= 3 THEN 1 ELSE 0 END
             )::numeric, 4) AS score
      FROM filtered fd
      LEFT JOIN attempt_flags ON attempt_flags.id = fd.id
      LEFT JOIN money ON money.id = fd.id
      LEFT JOIN type_counts ON type_counts."defectTypeId" = fd."defectTypeId"
      LEFT JOIN liable_ids ON liable_ids.id = fd.id
      LEFT JOIN engineer_ids ON engineer_ids.id = fd.id
      WHERE fd.status <> 'COMPLETED'
    )
    SELECT jsonb_build_object(
      'acts', (SELECT count(DISTINCT "actId")::int FROM filtered),
      'defects', (SELECT count(*)::int FROM filtered),
      'open_defects', (SELECT count(*) FILTER (WHERE status IN ('IN_PROGRESS', 'PENDING_INSPECTION'))::int FROM filtered),
      'overdue_defects', (SELECT count(*) FILTER (WHERE status <> 'COMPLETED' AND "effectiveDeadline" IS NOT NULL AND "effectiveDeadline" < now())::int FROM filtered),
      'no_responsible', (SELECT count(*) FILTER (WHERE engineer_ids.id IS NULL)::int FROM filtered LEFT JOIN engineer_ids ON engineer_ids.id = filtered.id),
      'no_liable', (SELECT count(*) FILTER (WHERE liable_ids.id IS NULL)::int FROM filtered LEFT JOIN liable_ids ON liable_ids.id = filtered.id),
      'no_movement', (SELECT count(*) FILTER (WHERE status = 'IN_PROGRESS' AND "updatedAt" < now() - make_interval(days => 14))::int FROM filtered),
      'closed_in_period', (
        SELECT count(*)::int FROM filtered fd
        WHERE fd.status = 'COMPLETED' ${closureFrom} ${closureTo}
      ),
      'median', (
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fd."readyAt" - fd."createdAt")) * 1000)
        FROM filtered fd
        WHERE fd.status = 'COMPLETED' AND fd."readyAt" IS NOT NULL AND fd."readyAt" >= fd."createdAt"
      ),
      'p90', (
        SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fd."readyAt" - fd."createdAt")) * 1000)
        FROM filtered fd
        WHERE fd.status = 'COMPLETED' AND fd."readyAt" IS NOT NULL AND fd."readyAt" >= fd."createdAt"
      ),
      'closure_sample', (
        SELECT count(*)::int FROM filtered fd
        WHERE fd.status = 'COMPLETED' AND fd."readyAt" IS NOT NULL AND fd."readyAt" >= fd."createdAt"
      ),
      'accepted_first', (
        SELECT count(*)::int FROM filtered fd
        JOIN attempt_flags ON attempt_flags.id = fd.id
        WHERE fd.status = 'COMPLETED' AND attempt_flags.accepted_first
      ),
      'with_attempts', (
        SELECT count(*)::int FROM filtered fd
        JOIN attempt_flags ON attempt_flags.id = fd.id
        WHERE fd.status = 'COMPLETED' AND attempt_flags.attempt_count > 0
      ),
      'completed', (SELECT count(*) FILTER (WHERE status = 'COMPLETED')::int FROM filtered),
      'attempt_sum', (SELECT coalesce(sum(attempt_count), 0)::int FROM attempt_flags),
      'attempt_defects', (SELECT count(*)::int FROM filtered),
      'new_insights', (
        SELECT count(*)::int
        FROM public.analytics_insights insight
        WHERE insight."scopeFingerprint" = ${input.scopeFingerprint}
          AND insight.active = true
          AND insight."supportAvailable" = true
          AND insight.status::text = 'NEW'
          ${excluded}
          AND public.sgr_insight_intersects_scope(insight.id)
      ),
      'invalid_temporal', (
        SELECT count(*)::int
        FROM filtered fd
        LEFT JOIN attempt_flags ON attempt_flags.id = fd.id
        WHERE (fd."readyAt" IS NOT NULL AND fd."readyAt" < fd."createdAt")
           OR (fd."submittedForInspectionAt" IS NOT NULL AND fd."submittedForInspectionAt" < fd."createdAt")
           OR (fd."acceptedAt" IS NOT NULL AND fd."acceptedAt" < fd."createdAt")
           OR (fd."rejectedAt" IS NOT NULL AND fd."rejectedAt" < fd."createdAt")
           OR (
             fd."acceptedAt" IS NOT NULL AND fd."submittedForInspectionAt" IS NOT NULL
             AND fd."acceptedAt" < fd."submittedForInspectionAt"
           )
           OR coalesce(attempt_flags.temporal_invalid, false)
      ),
      'temporal_total', (SELECT count(*)::int FROM filtered),
      'series', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'period', period, 'opened', opened, 'closed', closed
        ) ORDER BY period), '[]'::jsonb)
        FROM (
          SELECT period, sum(opened)::int AS opened, sum(closed)::int AS closed
          FROM (
            SELECT to_char(fd."createdAt" AT TIME ZONE 'Europe/Minsk', 'YYYY-MM') AS period,
                   1 AS opened, 0 AS closed
            FROM filtered fd
            UNION ALL
            SELECT to_char(fd."readyAt" AT TIME ZONE 'Europe/Minsk', 'YYYY-MM'), 0, 1
            FROM filtered fd
            WHERE fd.status = 'COMPLETED' AND fd."readyAt" IS NOT NULL
          ) points
          GROUP BY period
        ) periods
      ),
      'aging', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'count', bucket_count)), '[]'::jsonb)
        FROM (
          SELECT bucket, count(*)::int AS bucket_count
          FROM (
            SELECT CASE
              WHEN age_days <= 3 THEN '0–3'
              WHEN age_days <= 7 THEN '4–7'
              WHEN age_days <= 14 THEN '8–14'
              WHEN age_days <= 30 THEN '15–30'
              WHEN age_days <= 60 THEN '31–60'
              ELSE '60+'
            END AS bucket
            FROM (
              SELECT EXTRACT(EPOCH FROM (now() - fd."createdAt")) / 86400 AS age_days
              FROM filtered fd
              WHERE fd.status IN ('IN_PROGRESS', 'PENDING_INSPECTION')
            ) ages
          ) buckets
          GROUP BY bucket
        ) grouped
      ),
      'top_risks', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', picked.id, 'act_id', picked.act_id, 'label', picked.label, 'score', picked.score::text
        ) ORDER BY picked.score DESC, picked.id ASC), '[]'::jsonb)
        FROM (
          SELECT id, act_id, label, score
          FROM ranked
          ORDER BY score DESC, id ASC
          LIMIT ${ANALYTICS_TOP_RISK_LIMIT}
        ) picked
      ),
      'company_cost', ${companyCost},
      'gross', ${exposureGross},
      'recovery', ${exposureRecovery},
      'exposure_records', ${exposureRecords},
      'backlog_open', ${backlogOpen},
      'backlog_evaluated', ${backlogEvaluated},
      'backlog_unweighted', ${backlogUnweighted},
      'backlog_weighted', ${backlogWeighted},
      'top_organizations', ${topOrganizations}
    ) AS payload
  `;
}
