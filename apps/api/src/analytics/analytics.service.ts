import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  analyticsQuerySchema,
  insightReviewSchema,
  type AnalyticsCosts,
  type AnalyticsDataQuality,
  type AnalyticsDrilldown,
  type AnalyticsFilterOptions,
  type AnalyticsLiability,
  type AnalyticsDuration,
  supportDrilldownSchema,
  type AnalyticsOverview,
  type AnalyticsPatterns,
  type AnalyticsProcess,
  type AnalyticsQuery,
  type AnalyticsSupportDrilldown,
} from '@sgr-registry/contracts';
import { Prisma } from '@sgr-registry/database';
import {
  ANALYTICS_DRILLDOWN_PAGE_SIZE,
  ANALYTICS_INSPECTION_WAIT_DAYS,
  ANALYTICS_MIN_ORG_SAMPLE,
  ANALYTICS_TOP_RISK_LIMIT,
  BACKLOG_RISK_FORMULA_VERSION,
  MISSING_ANALYTICS_DIMENSIONS,
  SHARE_WITHOUT_EXPOSURE_LABEL,
  UNAVAILABLE_METRIC_TEXT,
  ValidationError,
  assertAnalyticsRange,
  canonicalAnalyticsFilter,
  durationStats,
  firstTimeRight,
  formatCoverage,
  hasCapability,
  organizationQualityIndex,
  ratio,
  reworkRate,
  satisfiesCapability,
  signalDisplayLabel,
  subtractMoney,
} from '@sgr-registry/domain';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { PrismaService } from '../auth/prisma.tokens.js';
import { parseCommandBody } from '../common/command-body.js';
import { actorContext } from '../common/request-context.js';
import { toJsonValue, writeAuditLog } from '../common/audit-writer.js';
import {
  resolveRegistryAccessScope,
  type RegistryAccessScope,
} from '../registry/registry-access-scope.js';
import { analyticsDefectWhere, scopedFrom } from './analytics-filter.js';
import { analyticsScopeStamp, refreshAnalyticsPatterns } from './analytics-patterns.js';

@Injectable()
export class AnalyticsService {
  constructor(@Inject(PrismaService) private readonly prismaService: PrismaService) {}

  private get prisma() {
    return this.prismaService.client;
  }

  async overview(user: AuthenticatedUser, raw: unknown): Promise<AnalyticsOverview> {
    const ctx = await this.context(user, raw);
    await this.refresh(ctx);
    const where = ctx.where;
    const [counts, closure, attempts, seriesOpened, seriesClosed, aging, risks, orgs, insights] =
      await Promise.all([
        this.one<{
          acts: number;
          defects: number;
          open_defects: number;
          overdue_defects: number;
          no_responsible: number;
          no_liable: number;
          no_movement: number;
          closed_in_period: number;
        }>(Prisma.sql`
          SELECT
            count(DISTINCT a.id)::int AS acts,
            count(*)::int AS defects,
            count(*) FILTER (WHERE d.status::text IN ('IN_PROGRESS', 'PENDING_INSPECTION'))::int AS open_defects,
            count(*) FILTER (WHERE d.status::text <> 'COMPLETED' AND d."effectiveDeadline" IS NOT NULL AND d."effectiveDeadline" < now())::int AS overdue_defects,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.defect_item_engineers engineer WHERE engineer."defectItemId" = d.id))::int AS no_responsible,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.defect_item_liable_organizations liable WHERE liable."defectItemId" = d.id))::int AS no_liable,
            count(*) FILTER (WHERE d.status::text = 'IN_PROGRESS' AND d."updatedAt" < now() - make_interval(days => 14))::int AS no_movement,
            count(*) FILTER (WHERE d.status::text = 'COMPLETED' ${closureWindow(ctx.query)})::int AS closed_in_period
          ${scopedFrom(where)}
        `),
        this.one<{ median: number | null; p90: number | null; sample: number }>(Prisma.sql`
          SELECT
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (d."readyAt" - d."createdAt")) * 1000) AS median,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (d."readyAt" - d."createdAt")) * 1000) AS p90,
            count(d."readyAt")::int AS sample
          ${scopedFrom(where)}
          AND d.status::text = 'COMPLETED' AND d."readyAt" IS NOT NULL
        `),
        this.attemptSummary(where),
        this.many<{ period: string; n: number }>(Prisma.sql`
          SELECT to_char(d."createdAt" AT TIME ZONE 'Europe/Minsk', 'YYYY-MM') AS period, count(*)::int AS n
          ${scopedFrom(where)}
          GROUP BY 1 ORDER BY 1
        `),
        this.many<{ period: string; n: number }>(Prisma.sql`
          SELECT to_char(d."readyAt" AT TIME ZONE 'Europe/Minsk', 'YYYY-MM') AS period, count(*)::int AS n
          ${scopedFrom(where)}
          AND d.status::text = 'COMPLETED' AND d."readyAt" IS NOT NULL
          GROUP BY 1 ORDER BY 1
        `),
        this.aging(where),
        this.topRisks(where),
        ctx.financial && ctx.cross
          ? this.many<{ id: string; name: string; amount: string }>(Prisma.sql`
              SELECT org.id::text AS id, org."officialName" AS name, sum(impact."amountByn")::text AS amount
              ${scopedFrom(
                where,
                Prisma.sql`JOIN public.defect_financial_impacts impact ON impact."defectItemId" = d.id
                  AND impact.status::text = 'CONFIRMED'
                  AND impact."amountType"::text = 'ACTUAL_COST'
                  AND impact."payerType"::text = 'COMPANY'
                JOIN public.defect_item_liable_organizations link ON link."defectItemId" = d.id
                JOIN public.organizations org ON org.id = link."organizationId"`,
              )}
              GROUP BY org.id, org."officialName"
              ORDER BY sum(impact."amountByn") DESC
              LIMIT 5
            `)
          : Promise.resolve([]),
        this.one<{ n: number }>(Prisma.sql`
          SELECT count(*)::int AS n
          FROM public.analytics_insights insight
          WHERE insight."scopeFingerprint" = ${analyticsScopeStamp(ctx.scope).fingerprint}
            AND insight.status::text = 'NEW'
            AND insight.active = true
        `),
      ]);
    const ftr = attempts;
    const periods = new Map<string, { opened: number; closed: number }>();
    for (const row of seriesOpened) {
      periods.set(row.period, { opened: num(row.n), closed: 0 });
    }
    for (const row of seriesClosed) {
      const current = periods.get(row.period) ?? { opened: 0, closed: 0 };
      current.closed = num(row.n);
      periods.set(row.period, current);
    }
    return {
      filters: ctx.query,
      acts: num(counts?.acts),
      defects: num(counts?.defects),
      openDefects: num(counts?.open_defects),
      overdueDefects: num(counts?.overdue_defects),
      noResponsible: num(counts?.no_responsible),
      noLiableOrganization: num(counts?.no_liable),
      noMovement: num(counts?.no_movement),
      closedInPeriod: num(counts?.closed_in_period),
      medianClosureMs: numOrNull(closure?.median),
      p90ClosureMs: numOrNull(closure?.p90),
      closureSampleSize: num(closure?.sample),
      firstTimeRight: {
        numerator: ftr.numerator,
        denominator: ftr.denominator,
        rate: ftr.rate,
        coverageText: formatCoverage(ftr.coverageNumerator, ftr.coverageDenominator),
      },
      averageAttempts: attempts.averageAttempts,
      newInsights: num(insights?.n),
      openedClosed: [...periods.entries()].map(([period, value]) => ({ period, ...value })),
      backlogAge: aging,
      topRisks: risks,
      financialVisible: ctx.financial,
      crossOrganizationVisible: ctx.cross,
      canReviewInsights: ctx.review,
      ...(ctx.financial
        ? {
            companyActualCostByn: await this.moneySum(where, 'COMPANY'),
            topOrganizations: orgs.map((row) => ({
              organizationId: row.id,
              name: row.name,
              amountByn: row.amount,
            })),
            confirmedFinancialExposure: await this.confirmedExposure(where, ctx.query),
            riskWeightedOpenBacklog: await this.riskWeightedBacklog(where),
          }
        : {}),
    };
  }

  async costs(user: AuthenticatedUser, raw: unknown): Promise<AnalyticsCosts> {
    const ctx = await this.context(user, raw);
    this.requireFinancial(ctx);
    const where = ctx.where;
    const [
      company,
      liable,
      recovery,
      avoided,
      rework,
      byPeriod,
      byObject,
      byOrganization,
      byDefectType,
      records,
    ] = await Promise.all([
      this.moneySum(where, 'COMPANY'),
      this.moneySum(where, 'LIABLE'),
      this.moneySum(where, 'RECOVERY'),
      this.moneySum(where, 'AVOIDED'),
      this.moneySum(where, 'REWORK'),
      this.moneyGroup(where, `to_char(impact."occurredAt" AT TIME ZONE 'Europe/Minsk', 'YYYY-MM')`),
      this.moneyGroup(
        where,
        'po.id::text',
        Prisma.sql`JOIN public.property_objects po ON po.id = a."objectId"`,
        'po.name',
      ),
      ctx.cross
        ? this.moneyGroup(
            where,
            'org.id::text',
            Prisma.sql`JOIN public.defect_item_liable_organizations link ON link."defectItemId" = d.id JOIN public.organizations org ON org.id = link."organizationId"`,
            'org."officialName"',
          )
        : Promise.resolve([]),
      this.moneyGroup(
        where,
        'dt.id::text',
        Prisma.sql`JOIN public.defect_types dt ON dt.id = d."defectTypeId"`,
        'dt.name',
      ),
      this.many<{
        id: string;
        defect_id: string;
        act_id: string;
        amount_type: string;
        payer_type: string;
        amount: string;
        occurred_at: Date;
        status: string;
      }>(Prisma.sql`
          SELECT impact.id::text AS id, d.id::text AS defect_id, a.id::text AS act_id,
                 impact."amountType"::text AS amount_type, impact."payerType"::text AS payer_type,
                 impact."amountByn"::text AS amount, impact."occurredAt" AS occurred_at, impact.status::text AS status
          ${scopedFrom(
            where,
            Prisma.sql`JOIN public.defect_financial_impacts impact ON impact."defectItemId" = d.id
              AND impact.status::text = 'CONFIRMED'`,
          )}
          ORDER BY impact."occurredAt" DESC
          LIMIT 100
        `),
    ]);
    const money = await this.one<{
      n: number;
      mean: string | null;
      median: string | null;
    }>(Prisma.sql`
      WITH per_defect AS (
        SELECT d.id, sum(impact."amountByn") AS amount
        ${scopedFrom(
          where,
          Prisma.sql`JOIN public.defect_financial_impacts impact ON impact."defectItemId" = d.id
            AND impact.status::text = 'CONFIRMED'
            AND impact."amountType"::text = 'ACTUAL_COST'
            AND impact."payerType"::text = 'COMPANY'`,
        )}
        GROUP BY d.id
      ),
      ordered AS (
        SELECT amount, row_number() OVER (ORDER BY amount, id) AS rn, count(*) OVER () AS total
        FROM per_defect
      ),
      summary AS (
        SELECT count(*)::int AS n,
               CASE WHEN count(*) = 0 THEN NULL ELSE round(sum(amount) / count(*), 2)::text END AS mean
        FROM per_defect
      )
      SELECT summary.n, summary.mean,
             CASE
               WHEN summary.n = 0 THEN NULL
               WHEN summary.n % 2 = 1 THEN (
                 SELECT amount::text FROM ordered WHERE rn = (summary.n + 1) / 2
               )
               ELSE (
                 SELECT round((low.amount + high.amount) / 2, 2)::text
                 FROM ordered low
                 JOIN ordered high ON low.rn = summary.n / 2 AND high.rn = summary.n / 2 + 1
               )
             END AS median
      FROM summary
    `);
    return {
      companyActualCostByn: company,
      liableActualCostByn: liable,
      recoveryByn: recovery,
      avoidedLossByn: avoided,
      reworkCostByn: rework,
      meanDefectCostByn: money?.mean ?? null,
      medianDefectCostByn: money?.median ?? null,
      costSampleSize: num(money?.n),
      byPeriod: byPeriod.map((row) => ({ period: row.label, amountByn: row.amount })),
      byObject: byObject.map((row) => ({ id: row.id, label: row.label, amountByn: row.amount })),
      byOrganization: byOrganization.map((row) => ({
        id: row.id,
        label: row.label,
        amountByn: row.amount,
      })),
      byDefectType: byDefectType.map((row) => ({
        id: row.id,
        label: row.label,
        amountByn: row.amount,
      })),
      records: records.map((row) => ({
        id: row.id,
        defectItemId: row.defect_id,
        actId: row.act_id,
        amountType: row.amount_type,
        payerType: row.payer_type,
        amountByn: row.amount,
        occurredAt: row.occurred_at.toISOString(),
        status: row.status,
      })),
    };
  }

  async liability(user: AuthenticatedUser, raw: unknown): Promise<AnalyticsLiability> {
    const ctx = await this.context(user, raw);
    const rows = await this.many<{
      id: string;
      name: string;
      defects: number;
      total: number;
      ftr_num: number;
      with_attempts: number;
      completed: number;
      rework_num: number;
      overdue: number;
      timed: number;
      cost: string | null;
      objects: number;
      repeat_objects: number;
      median_days: number | null;
    }>(Prisma.sql`
      WITH scoped AS (
        SELECT d.id, d.status::text AS status, d."defectTypeId" AS type_id, d."effectiveDeadline" AS deadline,
               d."readyAt" AS ready_at, d."createdAt" AS created_at, a."objectId" AS object_id
        ${scopedFrom(ctx.where)}
      ),
      totals AS (SELECT count(*)::int AS total FROM scoped)
      SELECT org.id::text AS id, org."officialName" AS name,
             count(DISTINCT scoped.id)::int AS defects,
             max(totals.total)::int AS total,
             count(DISTINCT scoped.id) FILTER (
               WHERE scoped.status = 'COMPLETED' AND EXISTS (
                 SELECT 1 FROM public.defect_inspection_attempts attempt
                 WHERE attempt."defectItemId" = scoped.id AND attempt.status::text = 'ACCEPTED' AND attempt."attemptNumber" = 1
               )
             )::int AS ftr_num,
             count(DISTINCT scoped.id) FILTER (
               WHERE scoped.status = 'COMPLETED' AND EXISTS (
                 SELECT 1 FROM public.defect_inspection_attempts attempt WHERE attempt."defectItemId" = scoped.id
               )
             )::int AS with_attempts,
             count(DISTINCT scoped.id) FILTER (WHERE scoped.status = 'COMPLETED')::int AS completed,
             count(DISTINCT scoped.id) FILTER (
               WHERE scoped.status = 'COMPLETED' AND EXISTS (
                 SELECT 1 FROM public.defect_inspection_attempts attempt
                 WHERE attempt."defectItemId" = scoped.id AND attempt.status::text = 'REJECTED'
               )
             )::int AS rework_num,
             count(DISTINCT scoped.id) FILTER (
               WHERE scoped.status <> 'COMPLETED' AND scoped.deadline IS NOT NULL AND scoped.deadline < now()
             )::int AS overdue,
             count(DISTINCT scoped.id) FILTER (WHERE scoped.deadline IS NOT NULL)::int AS timed,
             ${
               ctx.financial
                 ? Prisma.sql`sum(impact."amountByn") FILTER (
                     WHERE impact.status::text = 'CONFIRMED' AND impact."amountType"::text = 'ACTUAL_COST' AND impact."payerType"::text = 'COMPANY'
                   )::text`
                 : Prisma.sql`NULL::text`
             } AS cost,
             count(DISTINCT scoped.object_id)::int AS objects,
             count(DISTINCT scoped.object_id) FILTER (
               WHERE scoped.type_id IN (
                 SELECT type_id FROM scoped GROUP BY type_id, object_id HAVING count(*) >= 2
               )
             )::int AS repeat_objects,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (scoped.ready_at - scoped.created_at)) / 86400.0
             ) FILTER (
               WHERE scoped.status = 'COMPLETED' AND scoped.ready_at IS NOT NULL
             ) AS median_days
      FROM scoped
      JOIN public.defect_item_liable_organizations link ON link."defectItemId" = scoped.id
      JOIN public.organizations org ON org.id = link."organizationId"
      LEFT JOIN public.defect_financial_impacts impact ON impact."defectItemId" = scoped.id
      CROSS JOIN totals
      GROUP BY org.id, org."officialName"
      ORDER BY count(DISTINCT scoped.id) DESC
      LIMIT 100
    `);
    const population = rows[0] ? num(rows[0].total) : 0;
    return {
      minimumSample: ANALYTICS_MIN_ORG_SAMPLE,
      rows: rows.map((row) => {
        const ftr = firstTimeRight({
          completedAcceptedOnFirstAttempt: num(row.ftr_num),
          completedWithAttempts: num(row.with_attempts),
          completedDefects: num(row.completed),
        });
        const rework = reworkRate({
          completedWithRejection: num(row.rework_num),
          completedWithAttempts: num(row.with_attempts),
        });
        const index = organizationQualityIndex({
          sampleSize: num(row.defects),
          firstTimeRight: ftr.rate,
          reworkRate: rework.rate,
          contractorOnTimeRate: null,
          overdueShare: ratio(num(row.overdue), num(row.timed)),
          medianClosureDays: numOrNull(row.median_days),
          repeatShare: null,
          confirmedCostPerDefect:
            ctx.financial && row.cost != null && num(row.defects) > 0
              ? Number(row.cost) / num(row.defects)
              : null,
          baselineCostPerDefect: null,
          objectRepeatShare: ratio(num(row.repeat_objects), num(row.objects)),
        });
        return {
          organizationId: row.id,
          name: row.name,
          defects: num(row.defects),
          share: ratio(num(row.defects), population),
          shareLabel: SHARE_WITHOUT_EXPOSURE_LABEL,
          firstTimeRight: ftr.rate,
          reworkRate: rework.rate,
          medianResolutionMs:
            row.median_days == null ? null : Math.round(num(row.median_days) * 86_400_000),
          overdueShare: ratio(num(row.overdue), num(row.defects)),
          confirmedCostByn: ctx.financial ? row.cost : null,
          sampleSize: num(row.defects),
          coverage: ftr.coverage,
          index: ctx.cross ? index.index : null,
          ranked: ctx.cross && index.ranked,
          components: index.components.map((component) => ({
            key: component.key,
            label: component.label,
            score: component.score,
            included: component.included,
          })),
        };
      }),
    };
  }

  async process(user: AuthenticatedUser, raw: unknown): Promise<AnalyticsProcess> {
    const ctx = await this.context(user, raw);
    const [funnel, clocks, aging, movement] = await Promise.all([
      this.many<{ status: string; n: number }>(Prisma.sql`
        SELECT d.status::text AS status, count(*)::int AS n
        ${scopedFrom(ctx.where)}
        GROUP BY 1
      `),
      this.one<{
        contractor_median: number | null;
        contractor_p75: number | null;
        contractor_p90: number | null;
        contractor_min: number | null;
        contractor_max: number | null;
        contractor_mean: number | null;
        contractor_sample: number;
        contractor_population: number;
        inspection_median: number | null;
        inspection_p75: number | null;
        inspection_p90: number | null;
        inspection_min: number | null;
        inspection_max: number | null;
        inspection_mean: number | null;
        inspection_sample: number;
        inspection_population: number;
        rework_median: number | null;
        rework_p75: number | null;
        rework_p90: number | null;
        rework_min: number | null;
        rework_max: number | null;
        rework_mean: number | null;
        rework_sample: number;
        rework_population: number;
        total_median: number | null;
        total_p75: number | null;
        total_p90: number | null;
        total_min: number | null;
        total_max: number | null;
        total_mean: number | null;
        total_sample: number;
        total_population: number;
      }>(Prisma.sql`
        WITH attempts AS (
          SELECT attempt."defectItemId", attempt."attemptNumber", attempt."submittedAt", attempt."reviewedAt",
                 lag(attempt."reviewedAt") OVER (PARTITION BY attempt."defectItemId" ORDER BY attempt."attemptNumber") AS prev_reviewed
          FROM public.defect_inspection_attempts attempt
        ),
        samples AS (
          SELECT
            CASE
              WHEN attempts."attemptNumber" = 1 THEN EXTRACT(EPOCH FROM (attempts."submittedAt" - COALESCE(a."startedAt", d."createdAt"))) * 1000
              WHEN attempts.prev_reviewed IS NOT NULL THEN EXTRACT(EPOCH FROM (attempts."submittedAt" - attempts.prev_reviewed)) * 1000
              ELSE NULL
            END AS contractor_ms,
            CASE
              WHEN attempts."reviewedAt" IS NULL THEN EXTRACT(EPOCH FROM (now() - attempts."submittedAt")) * 1000
              ELSE EXTRACT(EPOCH FROM (attempts."reviewedAt" - attempts."submittedAt")) * 1000
            END AS inspection_ms,
            CASE
              WHEN attempts."attemptNumber" > 1 AND attempts.prev_reviewed IS NOT NULL
                THEN EXTRACT(EPOCH FROM (attempts."submittedAt" - attempts.prev_reviewed)) * 1000
              ELSE NULL
            END AS rework_ms,
            CASE
              WHEN d.status::text = 'COMPLETED' AND d."readyAt" IS NOT NULL
                THEN EXTRACT(EPOCH FROM (d."readyAt" - d."createdAt")) * 1000
              ELSE NULL
            END AS total_ms
          ${scopedFrom(ctx.where, Prisma.sql`JOIN attempts ON attempts."defectItemId" = d.id`)}
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
      `),
      this.aging(ctx.where),
      this.one<{ n: number }>(Prisma.sql`
        SELECT count(*)::int AS n
        ${scopedFrom(analyticsDefectWhere(ctx.scope, ctx.query, 'noMovement'))}
      `),
    ]);
    const labels: Record<string, string> = {
      IN_PROGRESS: 'В работе у подрядчика',
      PENDING_INSPECTION: 'Ожидает проверки',
      COMPLETED: 'Завершено',
    };
    return {
      funnel: ['IN_PROGRESS', 'PENDING_INSPECTION', 'COMPLETED'].map((status) => ({
        status,
        label: labels[status] ?? status,
        count: num(funnel.find((row) => row.status === status)?.n),
      })),
      contractor: sqlDuration(clocks, 'contractor'),
      inspection: sqlDuration(clocks, 'inspection'),
      rework: sqlDuration(clocks, 'rework'),
      total: sqlDuration(clocks, 'total'),
      detectionToAssignment: durationStats([]),
      assignmentToWorkStart: durationStats([]),
      noMovement: num(movement?.n),
      aging,
      inspectionLabel: ctx.cross ? 'Ожидание проверки СГР' : 'Ожидание проверки',
    };
  }

  async patterns(user: AuthenticatedUser, raw: unknown): Promise<AnalyticsPatterns> {
    const ctx = await this.context(user, raw);
    await this.refresh(ctx);
    const stamp = analyticsScopeStamp(ctx.scope);
    const rows = await this.prisma.analyticsInsight.findMany({
      where: {
        scopeFingerprint: stamp.fingerprint,
        filterHash: canonicalAnalyticsFilter(ctx.query).hash,
        active: true,
      },
      orderBy: [{ supportCount: 'desc' }, { generatedAt: 'desc' }],
      take: 50,
      include: { reviewedBy: { select: { fullName: true } } },
    });
    return {
      items: rows
        .filter((row) => ctx.financial || row.signalType !== 'COST_CONCENTRATION')
        .filter((row) => ctx.cross || row.signalType !== 'INSPECTION_BOTTLENECK')
        .map((row) => ({
          id: row.id,
          signalType: row.signalType,
          title: signalDisplayLabel(row.status),
          plainLanguageExplanation: row.plainLanguageExplanation,
          dimensions: row.dimensions as Array<{ key: string; value: string; label: string }>,
          supportCount: row.supportCount,
          totalCount: row.totalCount,
          observedValue: Number(row.observedValue),
          baselineValue: Number(row.baselineValue),
          lift: row.lift == null ? null : Number(row.lift),
          confidence: row.confidence,
          sampleCoverage: row.sampleCoverage == null ? null : Number(row.sampleCoverage),
          periodFrom: row.periodFrom?.toISOString() ?? null,
          periodTo: row.periodTo?.toISOString() ?? null,
          generatedAt: row.generatedAt.toISOString(),
          ruleVersion: row.ruleVersion,
          status: row.status,
          displayLabel: signalDisplayLabel(row.status),
          statisticallyStable: row.statisticallyStable,
          reviewedBy: row.reviewedBy?.fullName ?? null,
          reviewedAt: row.reviewedAt?.toISOString() ?? null,
          reviewComment: row.reviewComment,
          canReview: ctx.review,
          supportAvailable: row.supportAvailable,
        })),
    };
  }

  async review(user: AuthenticatedUser, insightId: string, body: unknown, request: FastifyRequest) {
    if (!hasCapability(user.role, 'REVIEW_ANALYTICS_INSIGHTS')) {
      throw new ForbiddenException('Недостаточно прав');
    }
    const input = parseCommandBody(insightReviewSchema, body);
    const stamp = analyticsScopeStamp(await resolveRegistryAccessScope(this.prisma, user));
    const current = await this.prisma.analyticsInsight.findFirst({
      where: { id: insightId, scopeFingerprint: stamp.fingerprint },
    });
    if (!current) {
      throw new NotFoundException('Запись не найдена');
    }
    const updated = await this.prisma.analyticsInsight.update({
      where: { id: current.id },
      data: {
        status: input.status,
        reviewComment: input.comment,
        reviewedByUserId: user.id,
        reviewedAt: new Date(),
      },
    });
    await writeAuditLog(this.prisma, {
      ...actorContext(user, request),
      action: 'ANALYTICS_INSIGHT_REVIEWED',
      entityType: 'ANALYTICS_INSIGHT',
      entityId: updated.id,
      oldValue: toJsonValue({ status: current.status }),
      newValue: toJsonValue({ status: updated.status, comment: input.comment }),
      reason: input.comment,
    });
    return { id: updated.id, status: updated.status };
  }

  async dataQuality(user: AuthenticatedUser, raw: unknown): Promise<AnalyticsDataQuality> {
    const ctx = await this.context(user, raw);
    const row = await this.one<{
      total: number;
      missing_work: number;
      missing_liable: number;
      missing_responsible: number;
      missing_deadline: number;
      missing_attempts: number;
      missing_financial: number;
      imported: number;
      incomplete: number;
      unresolved: number;
    }>(Prisma.sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE d."workTypeId" IS NULL)::int AS missing_work,
        count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.defect_item_liable_organizations liable WHERE liable."defectItemId" = d.id))::int AS missing_liable,
        count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.defect_item_engineers engineer WHERE engineer."defectItemId" = d.id))::int AS missing_responsible,
        count(*) FILTER (WHERE d."effectiveDeadline" IS NULL)::int AS missing_deadline,
        count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.defect_inspection_attempts attempt WHERE attempt."defectItemId" = d.id))::int AS missing_attempts,
        count(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM public.defect_financial_impacts impact
          WHERE impact."defectItemId" = d.id AND impact.status::text = 'CONFIRMED'
        ))::int AS missing_financial,
        count(*) FILTER (WHERE d."importBatchId" IS NOT NULL OR d."sourceSystem" IS NOT NULL)::int AS imported,
        count(*) FILTER (WHERE d.status::text = 'COMPLETED' AND d."readyAt" IS NULL)::int AS incomplete,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM public.imported_engineer_references reference
          WHERE reference."defectItemId" = d.id
            AND reference."resolutionStatus"::text IN ('UNMATCHED', 'AMBIGUOUS')
        ))::int AS unresolved
      ${scopedFrom(ctx.where)}
    `);
    const exposure = await this.one<{ n: number }>(Prisma.sql`
      SELECT count(*)::int AS n FROM public.work_exposures
    `);
    const total = num(row?.total);
    const covered = (missing: number) => ({
      covered: Math.max(0, total - missing),
      total,
      rate: ratio(Math.max(0, total - missing), total),
    });
    const attempt = covered(num(row?.missing_attempts));
    return {
      missingDefectType: 0,
      missingWorkType: num(row?.missing_work),
      missingLiableOrganization: num(row?.missing_liable),
      missingResponsible: num(row?.missing_responsible),
      missingDeadline: num(row?.missing_deadline),
      missingAttemptHistory: num(row?.missing_attempts),
      missingFinancialData: ctx.financial ? num(row?.missing_financial) : 0,
      unresolvedEngineers: num(row?.unresolved),
      importedRecords: num(row?.imported),
      incompleteTimestamps: num(row?.incomplete),
      unavailableDimensions: [...MISSING_ANALYTICS_DIMENSIONS],
      defects: total,
      coverage: [
        { metric: 'workType', label: 'Вид работ', ...covered(num(row?.missing_work)) },
        {
          metric: 'liableOrganization',
          label: 'Виновная организация',
          ...covered(num(row?.missing_liable)),
        },
        {
          metric: 'responsible',
          label: 'Ответственный',
          ...covered(num(row?.missing_responsible)),
        },
        { metric: 'deadline', label: 'Срок', ...covered(num(row?.missing_deadline)) },
        { metric: 'attempts', label: 'История попыток', ...attempt },
        {
          metric: 'financial',
          label: 'Подтверждённые финансы',
          ...(ctx.financial
            ? covered(num(row?.missing_financial))
            : { covered: 0, total, rate: null }),
        },
        { metric: 'timestamps', label: 'Время завершения', ...covered(num(row?.incomplete)) },
        {
          metric: 'workExposure',
          label: 'Объём выполненных работ',
          covered: num(exposure?.n),
          total: num(exposure?.n),
          rate: num(exposure?.n) === 0 ? 0 : 1,
        },
      ].filter((item) => ctx.financial || item.metric !== 'financial'),
      unavailableMetrics: [
        { metric: 'DetectionToAssignment', reason: UNAVAILABLE_METRIC_TEXT },
        { metric: 'AssignmentToWorkStart', reason: UNAVAILABLE_METRIC_TEXT },
      ],
      workExposureRecords: num(exposure?.n),
    };
  }

  async supportDefects(
    user: AuthenticatedUser,
    insightId: string,
    raw: unknown,
  ): Promise<AnalyticsSupportDrilldown> {
    const query = parseCommandBody(supportDrilldownSchema, normalizeQuery(raw));
    const scope = await resolveRegistryAccessScope(this.prisma, user);
    const insight = await this.prisma.analyticsInsight.findFirst({ where: { id: insightId } });
    if (!insight) {
      throw new NotFoundException('Запись не найдена');
    }
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? ANALYTICS_DRILLDOWN_PAGE_SIZE;
    const sort = query.sort ?? 'createdAt';
    const direction = query.direction ?? 'desc';
    const empty = {
      insightId,
      supportAvailable: insight.supportAvailable,
      unavailableReason: insight.supportAvailable ? null : 'Support snapshot unavailable',
      signalType: insight.signalType,
      title: insight.title,
      ruleVersion: insight.ruleVersion,
      observedAt: insight.generatedAt.toISOString(),
      dimensions: insight.dimensions as Array<{ key: string; value: string; label: string }>,
      supportCount: 0,
      page,
      pageSize,
      sort,
      direction,
      items: [],
    };
    if (!insight.supportAvailable) {
      return empty;
    }
    const where = analyticsDefectWhere(scope, {});
    const order =
      sort === 'status'
        ? Prisma.sql`d.status::text`
        : sort === 'actNumber'
          ? Prisma.sql`a."officialNumber"`
          : Prisma.sql`d."createdAt"`;
    const directionSql = direction === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    const from = Prisma.sql`
      FROM public.analytics_insight_defects link
      JOIN public.defect_items d ON d.id = link."defectItemId"
      JOIN public.acts a ON a.id = d."actId"
      JOIN public.property_objects po ON po.id = a."objectId"
      JOIN public.defect_types dt ON dt.id = d."defectTypeId"
      LEFT JOIN public.work_types wt ON wt.id = d."workTypeId"
      WHERE link."insightId" = ${insightId}::uuid
        AND ${where}
    `;
    const totalRow = await this.one<{ n: number }>(Prisma.sql`SELECT count(*)::int AS n ${from}`);
    const cross = satisfiesCapability(user.role, 'VIEW_CROSS_ORGANIZATION_ANALYTICS');
    const rows = await this.many<{
      defect_id: string;
      label: string;
      act_id: string;
      act_number: string | null;
      object_name: string;
      defect_type: string;
      work_type: string | null;
      orgs: string | null;
      status: string;
      deadline: Date | null;
      attempts: number;
      reason: string;
    }>(Prisma.sql`
      SELECT d.id::text AS defect_id,
             coalesce(nullif(d.location, ''), dt.name) AS label,
             a.id::text AS act_id,
             a."officialNumber" AS act_number,
             po.name AS object_name,
             dt.name AS defect_type,
             wt.name AS work_type,
             ${
               cross || scope.organizationScoped
                 ? Prisma.sql`(
                     SELECT string_agg(org."officialName", ', ' ORDER BY org."officialName")
                     FROM public.defect_item_liable_organizations liable
                     JOIN public.organizations org ON org.id = liable."organizationId"
                     WHERE liable."defectItemId" = d.id
                   )`
                 : Prisma.sql`NULL::text`
             } AS orgs,
             d.status::text AS status,
             d."effectiveDeadline" AS deadline,
             (
               SELECT count(*)::int FROM public.defect_inspection_attempts attempt
               WHERE attempt."defectItemId" = d.id
             ) AS attempts,
             link."contributionReason" AS reason
      ${from}
      ORDER BY ${order} ${directionSql}, d.id ASC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `);
    return {
      ...empty,
      supportCount: num(totalRow?.n),
      items: rows.map((row) => ({
        defectItemId: row.defect_id,
        label: row.label,
        actId: row.act_id,
        actNumber: row.act_number,
        objectName: row.object_name,
        defectType: row.defect_type,
        workType: row.work_type,
        liableOrganizations: row.orgs ? row.orgs.split(', ') : [],
        status: row.status,
        deadline: row.deadline?.toISOString() ?? null,
        attemptCount: num(row.attempts),
        contributionReason: row.reason,
      })),
    };
  }

  async drilldown(user: AuthenticatedUser, raw: unknown): Promise<AnalyticsDrilldown> {
    const ctx = await this.context(user, raw);
    if (!ctx.query.metric) {
      throw new ValidationError('metric', 'Не указан показатель');
    }
    const financialMetrics = new Set([
      'companyActualCost',
      'liableActualCost',
      'recovery',
      'avoidedLoss',
      'reworkCost',
      'confirmedExposure',
      'riskWeightedBacklog',
    ]);
    if (financialMetrics.has(ctx.query.metric)) {
      this.requireFinancial(ctx);
    }
    const page = ctx.query.page ?? 1;
    const pageSize = ctx.query.pageSize ?? ANALYTICS_DRILLDOWN_PAGE_SIZE;
    const where = analyticsDefectWhere(ctx.scope, ctx.query, ctx.query.metric);
    const totalRow = await this.one<{ n: number }>(
      ctx.query.metric === 'acts'
        ? Prisma.sql`SELECT count(DISTINCT a.id)::int AS n ${scopedFrom(where)}`
        : Prisma.sql`SELECT count(*)::int AS n ${scopedFrom(where)}`,
    );
    const items = await this.many<{
      defect_id: string | null;
      act_id: string;
      act_number: string | null;
      object_name: string;
      orgs: string | null;
      status: string;
      created_at: Date;
      contribution: string | null;
    }>(
      ctx.query.metric === 'acts'
        ? Prisma.sql`
            SELECT NULL::text AS defect_id,
                   a.id::text AS act_id,
                   a."officialNumber" AS act_number,
                   po.name AS object_name,
                   NULL::text AS orgs,
                   min(d.status::text) AS status,
                   min(d."createdAt") AS created_at,
                   NULL::text AS contribution
            ${scopedFrom(where, Prisma.sql`JOIN public.property_objects po ON po.id = a."objectId"`)}
            GROUP BY a.id, a."officialNumber", po.name
            ORDER BY min(d."createdAt") DESC, a.id
            LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
          `
        : Prisma.sql`
            SELECT d.id::text AS defect_id,
                   a.id::text AS act_id,
                   a."officialNumber" AS act_number,
                   po.name AS object_name,
                   (
                     SELECT string_agg(org."officialName", ', ' ORDER BY org."officialName")
                     FROM public.defect_item_liable_organizations link
                     JOIN public.organizations org ON org.id = link."organizationId"
                     WHERE link."defectItemId" = d.id
                   ) AS orgs,
                   d.status::text AS status,
                   d."createdAt" AS created_at,
                   NULL::text AS contribution
            ${scopedFrom(where, Prisma.sql`JOIN public.property_objects po ON po.id = a."objectId"`)}
            ORDER BY d."createdAt" DESC, d.id
            LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
          `,
    );
    return {
      metric: ctx.query.metric,
      total: num(totalRow?.n),
      page,
      pageSize,
      filters: ctx.query,
      items: items.map((row) => ({
        defectItemId: row.defect_id,
        actId: row.act_id,
        actNumber: row.act_number,
        objectName: row.object_name,
        liableOrganizations: row.orgs ? row.orgs.split(', ') : [],
        status: row.status,
        createdAt: row.created_at.toISOString(),
        contribution: row.contribution,
      })),
    };
  }

  async filters(user: AuthenticatedUser, raw: unknown): Promise<AnalyticsFilterOptions> {
    const ctx = await this.context(user, raw);
    const [objects, customers, liable, workTypes, defectTypes] = await Promise.all([
      this.option(
        `po.id::text`,
        `po.name`,
        ctx.where,
        Prisma.sql`JOIN public.property_objects po ON po.id = a."objectId"`,
      ),
      this.option(
        `customer.id::text`,
        `customer."officialName"`,
        ctx.where,
        Prisma.sql`JOIN public.organizations customer ON customer.id = a."customerOrganizationId"`,
      ),
      this.option(
        `org.id::text`,
        `org."officialName"`,
        ctx.where,
        Prisma.sql`JOIN public.defect_item_liable_organizations link ON link."defectItemId" = d.id JOIN public.organizations org ON org.id = link."organizationId"`,
      ),
      this.option(
        `wt.id::text`,
        `wt.name`,
        ctx.where,
        Prisma.sql`JOIN public.work_types wt ON wt.id = d."workTypeId"`,
      ),
      this.option(
        `dt.id::text`,
        `dt.name`,
        ctx.where,
        Prisma.sql`JOIN public.defect_types dt ON dt.id = d."defectTypeId"`,
      ),
    ]);
    return {
      objects,
      customers,
      liableOrganizations: liable,
      workTypes,
      defectTypes,
      severityAvailable: false,
    };
  }

  private async context(user: AuthenticatedUser, raw: unknown) {
    await this.prisma.$executeRaw`SELECT set_config('statement_timeout', '8000', true)`;
    const query = parseCommandBody(analyticsQuerySchema, normalizeQuery(raw));
    if (query.source === 'manual' && query.importedOnly === 'true') {
      throw new ForbiddenException('Несовместимые фильтры источника');
    }
    assertAnalyticsRange(query.dateFrom, query.dateTo);
    const scope = await resolveRegistryAccessScope(this.prisma, user);
    return {
      query,
      scope,
      where: analyticsDefectWhere(scope, query),
      financial: satisfiesCapability(user.role, 'VIEW_FINANCIAL_ANALYTICS'),
      cross: satisfiesCapability(user.role, 'VIEW_CROSS_ORGANIZATION_ANALYTICS'),
      review: hasCapability(user.role, 'REVIEW_ANALYTICS_INSIGHTS'),
      canPersistInsights: hasCapability(user.role, 'VIEW_QUALITY_ANALYTICS'),
    };
  }

  private requireFinancial(ctx: { financial: boolean }) {
    if (!ctx.financial) {
      throw new ForbiddenException('Недостаточно прав');
    }
  }

  private async refresh(ctx: {
    where: Prisma.Sql;
    query: AnalyticsQuery;
    scope: RegistryAccessScope;
    financial: boolean;
    cross: boolean;
    canPersistInsights: boolean;
  }) {
    if (!ctx.canPersistInsights) {
      return;
    }
    await refreshAnalyticsPatterns((query) => this.prisma.$queryRaw(query), this.prisma, {
      where: ctx.where,
      query: ctx.query,
      scope: ctx.scope,
      financial: ctx.financial,
      crossOrganization: ctx.cross,
    });
  }

  private async attemptSummary(where: Prisma.Sql) {
    const row = await this.one<{
      accepted_first: number;
      with_attempts: number;
      completed: number;
      reworked: number;
      attempt_sum: number;
      attempt_defects: number;
    }>(Prisma.sql`
      SELECT
        count(*) FILTER (
          WHERE d.status::text = 'COMPLETED' AND EXISTS (
            SELECT 1 FROM public.defect_inspection_attempts attempt
            WHERE attempt."defectItemId" = d.id AND attempt.status::text = 'ACCEPTED' AND attempt."attemptNumber" = 1
          )
        )::int AS accepted_first,
        count(*) FILTER (
          WHERE d.status::text = 'COMPLETED' AND EXISTS (
            SELECT 1 FROM public.defect_inspection_attempts attempt WHERE attempt."defectItemId" = d.id
          )
        )::int AS with_attempts,
        count(*) FILTER (WHERE d.status::text = 'COMPLETED')::int AS completed,
        count(*) FILTER (
          WHERE d.status::text = 'COMPLETED' AND EXISTS (
            SELECT 1 FROM public.defect_inspection_attempts attempt
            WHERE attempt."defectItemId" = d.id AND attempt.status::text = 'REJECTED'
          )
        )::int AS reworked,
        coalesce(sum(attempt_count.n), 0)::int AS attempt_sum,
        count(attempt_count.n)::int AS attempt_defects
      ${scopedFrom(
        where,
        Prisma.sql`LEFT JOIN LATERAL (
          SELECT count(*)::int AS n FROM public.defect_inspection_attempts attempt WHERE attempt."defectItemId" = d.id
        ) attempt_count ON true`,
      )}
    `);
    return {
      ...firstTimeRight({
        completedAcceptedOnFirstAttempt: num(row?.accepted_first),
        completedWithAttempts: num(row?.with_attempts),
        completedDefects: num(row?.completed),
      }),
      reworked: num(row?.reworked),
      averageAttempts: ratio(num(row?.attempt_sum), num(row?.attempt_defects)),
    };
  }

  private aging(where: Prisma.Sql) {
    return this.many<{ bucket: string; count: number }>(
      Prisma.sql`
      SELECT bucket, count(*)::int AS count FROM (
        SELECT CASE
          WHEN age_days <= 3 THEN '0–3'
          WHEN age_days <= 7 THEN '4–7'
          WHEN age_days <= 14 THEN '8–14'
          WHEN age_days <= 30 THEN '15–30'
          WHEN age_days <= 60 THEN '31–60'
          ELSE '60+'
        END AS bucket
        FROM (
          SELECT EXTRACT(EPOCH FROM (now() - d."createdAt")) / 86400 AS age_days
          ${scopedFrom(where)}
          AND d.status::text IN ('IN_PROGRESS', 'PENDING_INSPECTION')
        ) ages
      ) buckets
      GROUP BY bucket
    `,
    ).then((rows) => {
      const order = ['0–3', '4–7', '8–14', '15–30', '31–60', '60+'];
      return order.map((bucket) => ({
        bucket,
        count: num(rows.find((row) => row.bucket === bucket)?.count),
      }));
    });
  }

  private async topRisks(where: Prisma.Sql) {
    const rows = await this.many<{ id: string; act_id: string; label: string; score: string }>(
      Prisma.sql`
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
    `,
    );
    return rows.map((row) => ({
      defectItemId: row.id,
      actId: row.act_id,
      label: row.label,
      score: row.score,
    }));
  }

  private async confirmedExposure(
    where: Prisma.Sql,
    query: AnalyticsQuery,
  ): Promise<NonNullable<AnalyticsOverview['confirmedFinancialExposure']>> {
    const row = await this.one<{ gross: string | null; recovery: string | null; records: number }>(
      Prisma.sql`
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
    `,
    );
    const records = num(row?.records);
    if (records === 0 || (row?.gross == null && row?.recovery == null)) {
      return {
        available: false as const,
        currency: 'BYN',
        periodFrom: query.dateFrom ?? null,
        periodTo: query.dateTo ?? null,
        recordCount: 0,
      };
    }
    const gross = row?.gross ?? '0.00';
    const recovery = row?.recovery ?? '0.00';
    return {
      available: true as const,
      currency: 'BYN',
      grossCompanyCostByn: gross,
      confirmedRecoveryByn: recovery,
      netConfirmedExposureByn: subtractMoney(gross, recovery),
      recordCount: records,
      periodFrom: query.dateFrom ?? null,
      periodTo: query.dateTo ?? null,
    };
  }

  private async riskWeightedBacklog(where: Prisma.Sql) {
    const row = await this.one<{
      open_count: number;
      evaluated: number;
      unweighted: string | null;
      weighted: string | null;
    }>(Prisma.sql`
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
    `);
    const openDefects = num(row?.open_count);
    const evaluated = num(row?.evaluated);
    return {
      available: evaluated > 0,
      weightedByn: evaluated > 0 ? (row?.weighted ?? null) : null,
      unweightedByn: evaluated > 0 ? (row?.unweighted ?? null) : null,
      evaluatedDefects: evaluated,
      openDefects,
      monetaryCoverage: openDefects === 0 ? null : evaluated / openDefects,
      formulaVersion: BACKLOG_RISK_FORMULA_VERSION,
      calculatedAt: new Date().toISOString(),
      inspectionWaitDays: ANALYTICS_INSPECTION_WAIT_DAYS,
    };
  }

  private async moneySum(
    where: Prisma.Sql,
    kind: 'COMPANY' | 'LIABLE' | 'RECOVERY' | 'AVOIDED' | 'REWORK',
  ): Promise<string | null> {
    const predicate =
      kind === 'COMPANY'
        ? Prisma.sql`impact.status::text = 'CONFIRMED' AND impact."amountType"::text = 'ACTUAL_COST' AND impact."payerType"::text = 'COMPANY'`
        : kind === 'LIABLE'
          ? Prisma.sql`impact.status::text = 'CONFIRMED' AND impact."amountType"::text = 'ACTUAL_COST' AND impact."payerType"::text = 'LIABLE_ORGANIZATION'`
          : kind === 'RECOVERY'
            ? Prisma.sql`impact.status::text = 'CONFIRMED' AND impact."amountType"::text = 'RECOVERY'`
            : kind === 'AVOIDED'
              ? Prisma.sql`impact.status::text = 'CONFIRMED' AND impact."amountType"::text = 'AVOIDED_LOSS'`
              : Prisma.sql`impact.status::text = 'CONFIRMED' AND impact."amountType"::text = 'ACTUAL_COST' AND impact."payerType"::text = 'COMPANY'
                  AND EXISTS (
                    SELECT 1 FROM public.defect_inspection_attempts attempt
                    WHERE attempt."defectItemId" = d.id AND (attempt."attemptNumber" > 1 OR attempt.status::text = 'REJECTED')
                  )`;
    const row = await this.one<{ amount: string | null }>(Prisma.sql`
      SELECT sum(impact."amountByn")::text AS amount
      ${scopedFrom(
        where,
        Prisma.sql`JOIN public.defect_financial_impacts impact ON impact."defectItemId" = d.id AND ${predicate}`,
      )}
    `);
    return row?.amount ?? null;
  }

  private moneyGroup(
    where: Prisma.Sql,
    idExpr: string,
    joins: Prisma.Sql = Prisma.empty,
    labelExpr = idExpr,
  ) {
    return this.many<{ id: string; label: string; amount: string }>(
      Prisma.sql`
      SELECT ${Prisma.raw(idExpr)} AS id, ${Prisma.raw(labelExpr)} AS label, sum(impact."amountByn")::text AS amount
      ${scopedFrom(
        where,
        Prisma.sql`${joins}
          JOIN public.defect_financial_impacts impact ON impact."defectItemId" = d.id
            AND impact.status::text = 'CONFIRMED'
            AND impact."amountType"::text = 'ACTUAL_COST'
            AND impact."payerType"::text = 'COMPANY'`,
      )}
      GROUP BY ${Prisma.raw(idExpr)}, ${Prisma.raw(labelExpr)}
      ORDER BY sum(impact."amountByn") DESC
      LIMIT 20
    `,
    ).then((rows) =>
      rows.map((row) => ({ id: String(row.id), label: String(row.label), amount: row.amount })),
    );
  }

  private option(idExpr: string, labelExpr: string, where: Prisma.Sql, joins: Prisma.Sql) {
    return this.many<{ id: string; label: string }>(
      Prisma.sql`
      SELECT DISTINCT ${Prisma.raw(idExpr)} AS id, ${Prisma.raw(labelExpr)} AS label
      ${scopedFrom(where, joins)}
      ORDER BY 2
      LIMIT 200
    `,
    ).then((rows) => rows.map((row) => ({ id: String(row.id), label: String(row.label) })));
  }

  private async one<T>(query: Prisma.Sql): Promise<T | null> {
    const rows = await this.prisma.$queryRaw<T[]>(query);
    return rows[0] ?? null;
  }

  private many<T>(query: Prisma.Sql): Promise<T[]> {
    return this.prisma.$queryRaw<T[]>(query);
  }
}

function normalizeQuery(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const source = raw as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') {
      next[key] = value;
    }
  }
  return next;
}

function closureWindow(query: AnalyticsQuery): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (query.dateFrom) {
    parts.push(Prisma.sql`AND d."readyAt" >= ${new Date(`${query.dateFrom}T00:00:00.000+03:00`)}`);
  }
  if (query.dateTo) {
    parts.push(Prisma.sql`AND d."readyAt" <= ${new Date(`${query.dateTo}T23:59:59.999+03:00`)}`);
  }
  return parts.length === 0 ? Prisma.empty : Prisma.join(parts, ' ');
}

function sqlDuration(row: Record<string, number | null> | null, prefix: string): AnalyticsDuration {
  const sample = num(row?.[`${prefix}_sample`]);
  const population = num(row?.[`${prefix}_population`]);
  return {
    median: numOrNull(row?.[`${prefix}_median`]),
    p75: numOrNull(row?.[`${prefix}_p75`]),
    p90: numOrNull(row?.[`${prefix}_p90`]),
    minimum: numOrNull(row?.[`${prefix}_min`]),
    maximum: numOrNull(row?.[`${prefix}_max`]),
    mean: numOrNull(row?.[`${prefix}_mean`]),
    sampleSize: sample,
    populationSize: population,
    coverage: population === 0 ? null : sample / population,
  };
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numOrNull(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
