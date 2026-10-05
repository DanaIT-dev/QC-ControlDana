import type { AnalyticsQuery } from '@sgr-registry/contracts';
import { Prisma, type PrismaClient } from '@sgr-registry/database';
import {
  ANALYTICS_RULE_VERSION,
  assessProportionSignal,
  assessShareSignal,
  signalDisplayLabel,
  type ProportionSignal,
} from '@sgr-registry/domain';
import type { RegistryAccessScope } from '../registry/registry-access-scope.js';
import { scopedFrom } from './analytics-filter.js';

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

export async function refreshAnalyticsPatterns(
  raw: Raw,
  prisma: Pick<PrismaClient, 'analyticsInsight'>,
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
  const keys: string[] = [];
  const now = new Date();
  for (const signal of signals) {
    keys.push(signal.signalKey);
    await prisma.analyticsInsight.upsert({
      where: {
        signalKey_scopeFingerprint: {
          signalKey: signal.signalKey,
          scopeFingerprint: stamp.fingerprint,
        },
      },
      create: {
        signalKey: signal.signalKey,
        signalType: signal.signalType,
        title: signal.title,
        plainLanguageExplanation: signal.plainLanguageExplanation,
        dimensions: signal.dimensions,
        supportCount: signal.supportCount,
        totalCount: signal.totalCount,
        observedValue: signal.observedValue,
        baselineValue: signal.baselineValue,
        lift: signal.lift,
        confidence: signal.confidence,
        sampleCoverage: signal.sampleCoverage,
        periodFrom: input.query.dateFrom
          ? new Date(`${input.query.dateFrom}T00:00:00.000+03:00`)
          : null,
        periodTo: input.query.dateTo ? new Date(`${input.query.dateTo}T00:00:00.000+03:00`) : null,
        generatedAt: now,
        ruleVersion: ANALYTICS_RULE_VERSION,
        status: 'NEW',
        statisticallyStable: signal.statisticallyStable,
        active: true,
        scopeKind: stamp.kind,
        scopeFingerprint: stamp.fingerprint,
        scopeOrganizationId: stamp.organizationId,
        scopeUserId: stamp.userId,
      },
      update: {
        title: signal.title,
        plainLanguageExplanation: signal.plainLanguageExplanation,
        dimensions: signal.dimensions,
        supportCount: signal.supportCount,
        totalCount: signal.totalCount,
        observedValue: signal.observedValue,
        baselineValue: signal.baselineValue,
        lift: signal.lift,
        confidence: signal.confidence,
        sampleCoverage: signal.sampleCoverage,
        generatedAt: now,
        ruleVersion: ANALYTICS_RULE_VERSION,
        statisticallyStable: signal.statisticallyStable,
        active: true,
      },
    });
  }
  if (keys.length === 0) {
    await prisma.analyticsInsight.updateMany({
      where: { scopeFingerprint: stamp.fingerprint, status: 'NEW', active: true },
      data: { active: false },
    });
    return;
  }
  await prisma.analyticsInsight.updateMany({
    where: {
      scopeFingerprint: stamp.fingerprint,
      status: 'NEW',
      active: true,
      signalKey: { notIn: keys },
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
): Promise<ProportionSignal[]> {
  const period = {
    periodFrom: input.query.dateFrom ?? null,
    periodTo: input.query.dateTo ?? null,
  };
  const signals: ProportionSignal[] = [];
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
    const signal = proportion(row, 'HIGH_REWORK', 'liableOrganization', 'defectType', period, true);
    if (signal) signals.push(signal);
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
    const signal = proportion(row, 'OVERDUE_CONCENTRATION', 'propertyObject', null, period, true);
    if (signal) signals.push(signal);
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
    if (signal && num(row.objects) >= 2) signals.push(signal);
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
    if (signal) signals.push(signal);
  }

  if (input.crossOrganization) {
    const bottleneck = await raw<GroupRow>(Prisma.sql`
      WITH scoped AS (
        SELECT d.id, a."objectId" AS object_id, po.name AS object_name
        ${scopedFrom(input.where, Prisma.sql`JOIN public.property_objects po ON po.id = a."objectId"`)}
      ),
      waits AS (
        SELECT attempt."defectItemId" AS id,
               EXTRACT(EPOCH FROM (coalesce(attempt."reviewedAt", now()) - attempt."submittedAt")) AS seconds
        FROM public.defect_inspection_attempts attempt
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
      const signal = proportion(row, 'INSPECTION_BOTTLENECK', 'propertyObject', null, period, true);
      if (signal) signals.push(signal);
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
      AND d.status::text = 'COMPLETED' AND d."readyAt" IS NOT NULL
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
    const signal = proportion(row, 'SLOW_RESOLUTION', 'defectType', null, period, true);
    if (signal) signals.push(signal);
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
    if (signal) signals.push(signal);
  }

  if (input.financial) {
    const costs = await raw<GroupRow>(Prisma.sql`
      WITH scoped AS (
        SELECT d.id, d."defectTypeId" AS type_id, dt.name AS type_name
        ${scopedFrom(input.where, Prisma.sql`JOIN public.defect_types dt ON dt.id = d."defectTypeId"`)}
      ),
      money AS (
        SELECT impact."defectItemId" AS id, sum(impact."amountByn") AS amount
        FROM public.defect_financial_impacts impact
        WHERE impact.status::text = 'CONFIRMED'
          AND impact."amountType"::text = 'ACTUAL_COST'
          AND impact."payerType"::text = 'COMPANY'
        GROUP BY impact."defectItemId"
      ),
      joined AS (
        SELECT scoped.type_id, scoped.type_name, money.amount
        FROM scoped JOIN money ON money.id = scoped.id
      ),
      base AS (SELECT coalesce(sum(amount), 0) AS total_amount, count(*)::int AS total FROM joined)
      SELECT type_id::text AS dim_id, type_name AS dim_label, NULL::text AS dim2_id, NULL::text AS dim2_label,
             count(*)::int AS support,
             1::int AS positive,
             1::int AS objects,
             max(base.total)::int AS baseline_total,
             1::int AS baseline_positive
      FROM joined CROSS JOIN base
      GROUP BY type_id, type_name, base.total_amount, base.total
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
      if (signal && num(row.baseline_total) > num(row.support))
        signals.push({ ...signal, supportCount: num(row.support) });
    }
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
