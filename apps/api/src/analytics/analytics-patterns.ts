import type { AnalyticsQuery } from '@sgr-registry/contracts';
import { lowFirstTimeRightSql, Prisma, type PrismaClient } from '@sgr-registry/database';
import {
  ANALYTICS_RULE_VERSION,
  assessLowFirstTimeRight,
  assessProportionSignal,
  assessShareSignal,
  canonicalAnalyticsFilter,
  insightSnapshotHash,
  signalDisplayLabel,
  type ProportionSignal,
} from '@sgr-registry/domain';
import type { RegistryAccessScope } from '../registry/registry-access-scope.js';
import { scopedFrom, withMaterializedAnalyticsScope } from './analytics-filter.js';

export { scopedFrom, withMaterializedAnalyticsScope };

type Sql = Prisma.Sql;
type Raw = <T>(query: Sql) => Promise<T[]>;

interface ScopeStamp {
  kind: 'COMPANY' | 'ORGANIZATION' | 'ASSIGNED';
  fingerprint: string;
  organizationId: string | null;
  userId: string | null;
}

export function analyticsScopeStamp(scope: RegistryAccessScope): ScopeStamp {
  if (scope.organizationScoped) {
    const ids = [...scope.organizationIds].sort();
    return {
      kind: 'ORGANIZATION',
      fingerprint: `org:${ids.join(',') || 'none'}`,
      organizationId: ids.length === 1 ? (ids[0] ?? null) : null,
      userId: null,
    };
  }
  if (scope.objectScoped) {
    return {
      kind: 'ASSIGNED',
      fingerprint: `user:${scope.userId}`,
      organizationId: null,
      userId: scope.userId,
    };
  }
  return { kind: 'COMPANY', fingerprint: 'company', organizationId: null, userId: null };
}

interface BuiltSignal {
  signal: ProportionSignal;
  reason: string;
  members: Sql;
}

export function isInsightSnapshotConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as { code?: string; message?: string; meta?: { code?: string } };
  const message = record.message ?? '';
  return (
    record.code === 'P2002' ||
    record.meta?.code === '23505' ||
    record.meta?.code === '25P02' ||
    message.includes('25P02') ||
    message.includes('analytics_insights_snapshot_scope_unique') ||
    message.includes('Unique constraint')
  );
}

export async function refreshAnalyticsPatterns(
  raw: Raw,
  prisma: Pick<PrismaClient, 'analyticsInsight' | 'analyticsInsightDefect' | '$transaction'>,
  input: {
    where: Sql;
    query: AnalyticsQuery;
    scope: RegistryAccessScope;
    financial: boolean;
    crossOrganization: boolean;
  },
): Promise<void> {
  const signals = await collectSignals(raw, input);
  const stamp = analyticsScopeStamp(input.scope);
  const filters = canonicalAnalyticsFilter(input.query);
  const keptKeys = new Set<string>();
  const now = new Date();
  for (const built of signals) {
    const digestRow = await raw<{ n: number; digest: string }>(Prisma.sql`
      WITH members AS (${built.members})
      SELECT count(*)::int AS n,
             encode(sha256(convert_to(coalesce(string_agg(id, ',' ORDER BY id), ''), 'UTF8')), 'hex') AS digest
      FROM members
    `);
    const digest = digestRow[0];
    const supportCount = num(digest?.n);
    if (!digest || supportCount !== built.signal.supportCount) {
      continue;
    }
    keptKeys.add(built.signal.signalKey);
    const snapshotHash = insightSnapshotHash({
      ruleVersion: ANALYTICS_RULE_VERSION,
      signalKey: built.signal.signalKey,
      filterHash: filters.hash,
      supportDigest: digest.digest,
      reason: built.reason,
    });
    const existing = await prisma.analyticsInsight.findFirst({
      where: { scopeFingerprint: stamp.fingerprint, snapshotHash, active: true },
      select: { id: true },
    });
    if (existing) {
      continue;
    }
    try {
      await prisma.$transaction(async (tx) => {
        const inserted = await tx.analyticsInsight.createMany({
          data: [
            {
              signalKey: built.signal.signalKey,
              signalType: built.signal.signalType,
              title: built.signal.title,
              plainLanguageExplanation: built.signal.plainLanguageExplanation,
              dimensions: built.signal.dimensions,
              supportCount,
              totalCount: built.signal.totalCount,
              observedValue: built.signal.observedValue.toFixed(6),
              baselineValue: built.signal.baselineValue.toFixed(6),
              lift: built.signal.lift == null ? null : built.signal.lift.toFixed(6),
              confidence: built.signal.confidence,
              sampleCoverage:
                built.signal.sampleCoverage == null ? null : built.signal.sampleCoverage.toFixed(4),
              periodFrom: input.query.dateFrom
                ? new Date(`${input.query.dateFrom}T00:00:00.000+03:00`)
                : null,
              periodTo: input.query.dateTo
                ? new Date(`${input.query.dateTo}T00:00:00.000+03:00`)
                : null,
              generatedAt: now,
              ruleVersion: ANALYTICS_RULE_VERSION,
              status: 'NEW',
              statisticallyStable: built.signal.statisticallyStable,
              active: true,
              scopeKind: stamp.kind,
              scopeFingerprint: stamp.fingerprint,
              scopeOrganizationId: stamp.organizationId,
              scopeUserId: stamp.userId,
              filterSnapshot: filters.snapshot,
              filterHash: filters.hash,
              snapshotHash,
              supportAvailable: true,
            },
          ],
          skipDuplicates: true,
        });
        if (inserted.count === 0) {
          return;
        }
        const created = await tx.analyticsInsight.findFirst({
          where: { scopeFingerprint: stamp.fingerprint, snapshotHash, active: true },
          select: { id: true },
        });
        if (!created) {
          return;
        }
        await tx.$queryRaw(Prisma.sql`
        SELECT public.sgr_insert_insight_support(
          ${created.id}::uuid,
          ${built.reason},
          ${now}::timestamptz,
          COALESCE(ARRAY(SELECT members.id::uuid FROM (${built.members}) AS members), ARRAY[]::uuid[])
        ) AS inserted
      `);
        await tx.analyticsInsight.updateMany({
          where: {
            scopeFingerprint: stamp.fingerprint,
            signalKey: built.signal.signalKey,
            filterHash: filters.hash,
            active: true,
            id: { not: created.id },
          },
          data: { active: false },
        });
      });
    } catch (error) {
      if (!isInsightSnapshotConflict(error)) {
        throw error;
      }
    }
  }
  await prisma.analyticsInsight.updateMany({
    where: {
      scopeFingerprint: stamp.fingerprint,
      filterHash: filters.hash,
      active: true,
      supportAvailable: true,
      ...(keptKeys.size === 0 ? {} : { signalKey: { notIn: [...keptKeys] } }),
    },
    data: { active: false },
  });
}

async function collectSignals(
  raw: Raw,
  input: {
    where: Sql;
    query: AnalyticsQuery;
    financial: boolean;
    crossOrganization: boolean;
  },
): Promise<BuiltSignal[]> {
  const period = {
    periodFrom: input.query.dateFrom ?? null,
    periodTo: input.query.dateTo ?? null,
  };
  const signals: BuiltSignal[] = [];
  const remember = (signal: ProportionSignal | null, reason: string, members: Sql) => {
    if (signal) {
      signals.push({ signal, reason, members });
    }
  };
  const rework = await raw<GroupRow>(Prisma.sql`
    WITH scoped AS (
      SELECT d.id, d.status::text AS status, d."defectTypeId" AS type_id, dt.name AS type_name,
             a."objectId" AS object_id
      ${scopedFrom(input.where, Prisma.sql`JOIN public.defect_types dt ON dt.id = d."defectTypeId"`)}
    ),
    flags AS (
      SELECT attempt."defectItemId" AS id,
             bool_or(attempt.status::text = 'REJECTED') AS rejected,
             count(*)::int AS attempts
      FROM public.defect_inspection_attempts attempt
      GROUP BY attempt."defectItemId"
    ),
    base AS (
      SELECT
        count(*) FILTER (WHERE scoped.status = 'COMPLETED' AND flags.attempts > 0)::int AS total,
        count(*) FILTER (WHERE scoped.status = 'COMPLETED' AND flags.rejected)::int AS positive
      FROM scoped
      LEFT JOIN flags ON flags.id = scoped.id
    )
    SELECT org.id::text AS dim_id, org."officialName" AS dim_label, scoped.type_id::text AS dim2_id,
           scoped.type_name AS dim2_label,
           count(*) FILTER (WHERE scoped.status = 'COMPLETED' AND flags.attempts > 0)::int AS support,
           count(*) FILTER (WHERE scoped.status = 'COMPLETED' AND flags.rejected)::int AS positive,
           count(DISTINCT scoped.object_id)::int AS objects,
           max(base.total)::int AS baseline_total,
           max(base.positive)::int AS baseline_positive
    FROM scoped
    JOIN flags ON flags.id = scoped.id
    JOIN public.defect_item_liable_organizations link ON link."defectItemId" = scoped.id
    JOIN public.organizations org ON org.id = link."organizationId"
    CROSS JOIN base
    GROUP BY org.id, org."officialName", scoped.type_id, scoped.type_name, base.total, base.positive
    HAVING count(*) FILTER (WHERE scoped.status = 'COMPLETED' AND flags.attempts > 0) >= 3
    ORDER BY positive DESC
    LIMIT 25
  `);
  for (const row of rework) {
    remember(
      proportion(row, 'HIGH_REWORK', 'liableOrganization', 'defectType', period, true),
      'Завершённый дефект с записанной попыткой проверки в сегменте повторного устранения',
      Prisma.sql`
        SELECT d.id::text AS id
        ${scopedFrom(input.where)}
        AND d.status::text = 'COMPLETED'
        AND EXISTS (
          SELECT 1 FROM public.defect_inspection_attempts attempt
          WHERE attempt."defectItemId" = d.id
        )
        AND EXISTS (
          SELECT 1 FROM public.defect_item_liable_organizations link
          WHERE link."defectItemId" = d.id AND link."organizationId" = ${row.dim_id}::uuid
        )
        AND d."defectTypeId" = ${row.dim2_id}::uuid
      `,
    );
  }

  const overdue = await raw<GroupRow>(Prisma.sql`
    WITH scoped AS (
      SELECT d.id,
             (d.status::text <> 'COMPLETED' AND d."effectiveDeadline" IS NOT NULL AND d."effectiveDeadline" < now()) AS overdue,
             a."objectId" AS object_id, po.name AS object_name
      ${scopedFrom(input.where, Prisma.sql`JOIN public.property_objects po ON po.id = a."objectId"`)}
    ),
    base AS (
      SELECT count(*)::int AS total, count(*) FILTER (WHERE overdue)::int AS positive FROM scoped
    )
    SELECT object_id::text AS dim_id, object_name AS dim_label, NULL::text AS dim2_id, NULL::text AS dim2_label,
           count(*)::int AS support,
           count(*) FILTER (WHERE overdue)::int AS positive,
           1::int AS objects,
           max(base.total)::int AS baseline_total,
           max(base.positive)::int AS baseline_positive
    FROM scoped CROSS JOIN base
    GROUP BY object_id, object_name, base.total, base.positive
    HAVING count(*) >= 3
    LIMIT 25
  `);
  for (const row of overdue) {
    remember(
      proportion(row, 'OVERDUE_CONCENTRATION', 'propertyObject', null, period, true),
      'Дефект объекта, по которому сравнивается доля просрочки',
      Prisma.sql`
        SELECT d.id::text AS id
        ${scopedFrom(input.where)}
        AND a."objectId" = ${row.dim_id}::uuid
      `,
    );
  }

  const repeated = await raw<GroupRow>(Prisma.sql`
    WITH scoped AS (
      SELECT d.id, d."defectTypeId" AS type_id, dt.name AS type_name, a."objectId" AS object_id
      ${scopedFrom(input.where, Prisma.sql`JOIN public.defect_types dt ON dt.id = d."defectTypeId"`)}
    ),
    base AS (SELECT count(*)::int AS total FROM scoped)
    SELECT type_id::text AS dim_id, type_name AS dim_label, NULL::text AS dim2_id, NULL::text AS dim2_label,
           count(*)::int AS support,
           count(DISTINCT object_id)::int AS positive,
           count(DISTINCT object_id)::int AS objects,
           max(base.total)::int AS baseline_total,
           GREATEST(count(DISTINCT object_id), 1)::int AS baseline_positive
    FROM scoped CROSS JOIN base
    GROUP BY type_id, type_name, base.total
    HAVING count(DISTINCT object_id) >= 2 AND count(*) >= 3
    LIMIT 25
  `);
  for (const row of repeated) {
    const signal = assessProportionSignal({
      signalType: 'REPEATED_DEFECT_ACROSS_OBJECTS',
      dimensions: [{ key: 'defectType', value: row.dim_id, label: row.dim_label }],
      supportCount: num(row.support),
      positiveCount: num(row.objects),
      totalCount: num(row.baseline_total),
      baselinePositive: 1,
      baselineTotal: Math.max(num(row.baseline_total), 1),
      objectCount: num(row.objects),
      sampleCoverage: null,
      ...period,
      higherIsSignal: true,
    });
    if (signal && num(row.objects) >= 2) {
      remember(
        signal,
        'Дефект типа, который встречается на нескольких объектах',
        Prisma.sql`
          SELECT d.id::text AS id
          ${scopedFrom(input.where)}
          AND d."defectTypeId" = ${row.dim_id}::uuid
        `,
      );
    }
  }

  const responsibility = await raw<GroupRow>(Prisma.sql`
    WITH scoped AS (
      SELECT d.id, a."objectId" AS object_id
      ${scopedFrom(input.where)}
    ),
    linked AS (
      SELECT link."organizationId" AS org_id, org."officialName" AS org_name, scoped.id, scoped.object_id
      FROM scoped
      JOIN public.defect_item_liable_organizations link ON link."defectItemId" = scoped.id
      JOIN public.organizations org ON org.id = link."organizationId"
    )
    SELECT org_id::text AS dim_id, org_name AS dim_label, NULL::text AS dim2_id, NULL::text AS dim2_label,
           count(*)::int AS support,
           count(*)::int AS positive,
           count(DISTINCT object_id)::int AS objects,
           (SELECT count(*)::int FROM scoped) AS baseline_total,
           (SELECT count(DISTINCT org_id)::int FROM linked) AS baseline_positive
    FROM linked
    GROUP BY org_id, org_name
    HAVING count(*) >= 3
    LIMIT 25
  `);
  const peers = responsibility.length;
  const total = responsibility[0] ? num(responsibility[0].baseline_total) : 0;
  for (const row of responsibility) {
    const signal = assessShareSignal({
      signalType: 'RESPONSIBILITY_CONCENTRATION',
      dimensions: [{ key: 'liableOrganization', value: row.dim_id, label: row.dim_label }],
      segmentCount: num(row.support),
      totalCount: total,
      peerCount: Math.max(peers, num(row.baseline_positive)),
      objectCount: num(row.objects),
      sampleCoverage: null,
      ...period,
    });
    if (signal) {
      remember(
        signal,
        'Дефект, связанный с организацией в сравнении долей',
        Prisma.sql`
          SELECT d.id::text AS id
          ${scopedFrom(input.where)}
          AND EXISTS (
            SELECT 1 FROM public.defect_item_liable_organizations link
            WHERE link."defectItemId" = d.id AND link."organizationId" = ${row.dim_id}::uuid
          )
        `,
      );
    }
  }

  if (input.crossOrganization) {
    const bottleneck = await raw<GroupRow>(Prisma.sql`
      WITH scoped AS (
        SELECT d.id, a."objectId" AS object_id, po.name AS object_name
        ${scopedFrom(input.where, Prisma.sql`JOIN public.property_objects po ON po.id = a."objectId"`)}
      ),
      waits AS (
        SELECT attempt."defectItemId" AS id,
               EXTRACT(EPOCH FROM (attempt."reviewedAt" - attempt."submittedAt")) AS seconds
        FROM public.defect_inspection_attempts attempt
        JOIN public.defect_items item ON item.id = attempt."defectItemId"
        WHERE attempt."reviewedAt" IS NOT NULL
          AND attempt."reviewedAt" >= attempt."submittedAt"
          AND attempt."submittedAt" >= item."createdAt"
      ),
      joined AS (
        SELECT scoped.object_id, scoped.object_name, waits.seconds
        FROM scoped JOIN waits ON waits.id = scoped.id
      ),
      median AS (
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS median_seconds,
               count(*)::int AS total
        FROM joined
      ),
      baseline AS (
        SELECT median.median_seconds, median.total,
               (SELECT count(*)::int FROM joined slower, median marker WHERE slower.seconds > marker.median_seconds) AS positive
        FROM median
      )
      SELECT object_id::text AS dim_id, object_name AS dim_label, NULL::text AS dim2_id, NULL::text AS dim2_label,
             count(*)::int AS support,
             count(*) FILTER (WHERE seconds > baseline.median_seconds)::int AS positive,
             1::int AS objects,
             max(baseline.total)::int AS baseline_total,
             max(baseline.positive)::int AS baseline_positive
      FROM joined CROSS JOIN baseline
      GROUP BY object_id, object_name, baseline.median_seconds, baseline.total, baseline.positive
      HAVING count(*) >= 3
      LIMIT 25
    `);
    for (const row of bottleneck) {
      remember(
        proportion(row, 'INSPECTION_BOTTLENECK', 'propertyObject', null, period, true),
        'Дефект объекта с записанным ожиданием проверки',
        Prisma.sql`
          SELECT d.id::text AS id
          ${scopedFrom(input.where)}
          AND a."objectId" = ${row.dim_id}::uuid
          AND EXISTS (
            SELECT 1 FROM public.defect_inspection_attempts attempt
            WHERE attempt."defectItemId" = d.id
          )
        `,
      );
    }
  }

  const slow = await raw<GroupRow>(Prisma.sql`
    WITH scoped AS (
      SELECT d.id, d."defectTypeId" AS type_id, dt.name AS type_name,
             EXTRACT(EPOCH FROM (d."readyAt" - d."createdAt")) AS seconds
      ${scopedFrom(
        input.where,
        Prisma.sql`JOIN public.defect_types dt ON dt.id = d."defectTypeId"`,
      )}
      AND d.status::text = 'COMPLETED' AND d."readyAt" IS NOT NULL AND d."readyAt" >= d."createdAt"
    ),
    median AS (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS median_seconds, count(*)::int AS total
      FROM scoped
    ),
    baseline AS (
      SELECT median.median_seconds, median.total,
             (SELECT count(*)::int FROM scoped slower, median marker WHERE slower.seconds > marker.median_seconds) AS positive
      FROM median
    )
    SELECT type_id::text AS dim_id, type_name AS dim_label, NULL::text AS dim2_id, NULL::text AS dim2_label,
           count(*)::int AS support,
           count(*) FILTER (WHERE seconds > baseline.median_seconds)::int AS positive,
           1::int AS objects,
           max(baseline.total)::int AS baseline_total,
           max(baseline.positive)::int AS baseline_positive
    FROM scoped CROSS JOIN baseline
    GROUP BY type_id, type_name, baseline.median_seconds, baseline.total, baseline.positive
    HAVING count(*) >= 3
    LIMIT 25
  `);
  for (const row of slow) {
    remember(
      proportion(row, 'SLOW_RESOLUTION', 'defectType', null, period, true),
      'Завершённый дефект типа с известным временем закрытия',
      Prisma.sql`
        SELECT d.id::text AS id
        ${scopedFrom(input.where)}
        AND d.status::text = 'COMPLETED'
        AND d."readyAt" IS NOT NULL
        AND d."readyAt" >= d."createdAt"
        AND d."defectTypeId" = ${row.dim_id}::uuid
      `,
    );
  }

  const quality = await raw<{ missing: number; total: number }>(Prisma.sql`
    SELECT
      count(*) FILTER (WHERE d."workTypeId" IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.defect_item_liable_organizations liable WHERE liable."defectItemId" = d.id
      ))::int AS missing,
      count(*)::int AS total
    ${scopedFrom(input.where)}
  `);
  const qualityRow = quality[0];
  if (qualityRow && num(qualityRow.total) > 0) {
    const signal = assessProportionSignal({
      signalType: 'DATA_QUALITY_RISK',
      dimensions: [
        {
          key: 'source',
          value: 'missing-core-fields',
          label: 'незаполненные вид работ или виновная организация',
        },
      ],
      supportCount: num(qualityRow.total),
      positiveCount: num(qualityRow.missing),
      totalCount: num(qualityRow.total),
      baselinePositive: 1,
      baselineTotal: 5,
      objectCount: 1,
      sampleCoverage: 1,
      ...period,
      higherIsSignal: true,
    });
    remember(
      signal,
      'Дефект выборки, в которой оценивается заполненность вида работ и виновной организации',
      Prisma.sql`SELECT d.id::text AS id ${scopedFrom(input.where)}`,
    );
  }

  if (input.financial) {
    const costs = await raw<GroupRow>(Prisma.sql`
      WITH per_defect AS (
        SELECT d.id, d."defectTypeId" AS type_id, dt.name AS type_name,
               sum(impact."amountByn") AS amount
        ${scopedFrom(
          input.where,
          Prisma.sql`JOIN public.defect_types dt ON dt.id = d."defectTypeId"
            JOIN public.defect_financial_impacts impact ON impact."defectItemId" = d.id
              AND impact.status::text = 'CONFIRMED'
              AND impact."amountType"::text = 'ACTUAL_COST'
              AND impact."payerType"::text = 'COMPANY'`,
        )}
        GROUP BY d.id, d."defectTypeId", dt.name
      )
      SELECT type_id::text AS dim_id, type_name AS dim_label, NULL::text AS dim2_id, NULL::text AS dim2_label,
             count(*)::int AS support,
             1::int AS positive,
             1::int AS objects,
             sum(count(*)) OVER ()::int AS baseline_total,
             1::int AS baseline_positive
      FROM per_defect
      GROUP BY type_id, type_name
      HAVING sum(amount) > 0 AND count(*) >= 3
      LIMIT 25
    `);
    for (const row of costs) {
      const signal = assessProportionSignal({
        signalType: 'COST_CONCENTRATION',
        dimensions: [{ key: 'defectType', value: row.dim_id, label: row.dim_label }],
        supportCount: num(row.support),
        positiveCount: num(row.support),
        totalCount: Math.max(num(row.baseline_total), 1),
        baselinePositive: 1,
        baselineTotal: Math.max(num(row.baseline_total), 1),
        objectCount: 1,
        sampleCoverage: null,
        ...period,
        higherIsSignal: true,
      });
      if (signal && num(row.baseline_total) > num(row.support)) {
        remember(
          { ...signal, supportCount: num(row.support) },
          'Дефект типа с подтверждёнными затратами компании',
          Prisma.sql`
            SELECT d.id::text AS id
            ${scopedFrom(input.where)}
            AND d."defectTypeId" = ${row.dim_id}::uuid
            AND EXISTS (
              SELECT 1 FROM public.defect_financial_impacts impact
              WHERE impact."defectItemId" = d.id
                AND impact.status::text = 'CONFIRMED'
                AND impact."amountType"::text = 'ACTUAL_COST'
                AND impact."payerType"::text = 'COMPANY'
            )
          `,
        );
      }
    }
  }

  const lowFirstTimeRight = await raw<
    GroupRow & { dim_key: string; completed: number; baseline_completed: number }
  >(lowFirstTimeRightSql(input.where));
  for (const row of lowFirstTimeRight) {
    const signal = assessLowFirstTimeRight({
      dimensions: [{ key: row.dim_key, value: row.dim_id, label: row.dim_label }],
      completedAcceptedOnFirst: num(row.positive),
      completedWithAttempts: num(row.support),
      completedDefects: num(row.completed),
      baselineAcceptedOnFirst: num(row.baseline_positive),
      baselineCompletedWithAttempts: num(row.baseline_total),
      ...period,
    });
    const predicate =
      row.dim_key === 'liableOrganization'
        ? Prisma.sql`EXISTS (
            SELECT 1 FROM public.defect_item_liable_organizations link
            WHERE link."defectItemId" = d.id AND link."organizationId" = ${row.dim_id}::uuid
          )`
        : row.dim_key === 'defectType'
          ? Prisma.sql`d."defectTypeId" = ${row.dim_id}::uuid`
          : row.dim_key === 'workType'
            ? Prisma.sql`d."workTypeId" = ${row.dim_id}::uuid`
            : Prisma.sql`a."objectId" = ${row.dim_id}::uuid`;
    remember(
      signal,
      'Завершённый дефект с реальной попыткой проверки в сегменте First-Time-Right',
      Prisma.sql`
        SELECT d.id::text AS id
        ${scopedFrom(input.where)}
        AND d.status::text = 'COMPLETED'
        AND EXISTS (
          SELECT 1 FROM public.defect_inspection_attempts attempt
          WHERE attempt."defectItemId" = d.id
        )
        AND ${predicate}
      `,
    );
  }

  return signals;
}

interface GroupRow {
  dim_id: string;
  dim_label: string;
  dim2_id: string | null;
  dim2_label: string | null;
  support: number;
  positive: number;
  objects: number;
  baseline_total: number;
  baseline_positive: number;
}

function proportion(
  row: GroupRow,
  signalType: ProportionSignal['signalType'],
  key: string,
  key2: string | null,
  period: { periodFrom: string | null; periodTo: string | null },
  higherIsSignal: boolean,
): ProportionSignal | null {
  const dimensions = [{ key, value: row.dim_id, label: row.dim_label }];
  if (key2 && row.dim2_id && row.dim2_label) {
    dimensions.push({ key: key2, value: row.dim2_id, label: row.dim2_label });
  }
  return assessProportionSignal({
    signalType,
    dimensions,
    supportCount: num(row.support),
    positiveCount: num(row.positive),
    totalCount: num(row.baseline_total),
    baselinePositive: num(row.baseline_positive),
    baselineTotal: num(row.baseline_total),
    objectCount: num(row.objects),
    sampleCoverage:
      num(row.baseline_total) === 0 ? null : num(row.support) / num(row.baseline_total),
    ...period,
    higherIsSignal,
  });
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function patternCardStatusLabel(status: 'NEW' | 'UNDER_REVIEW' | 'CONFIRMED' | 'DISMISSED') {
  return signalDisplayLabel(status);
}
