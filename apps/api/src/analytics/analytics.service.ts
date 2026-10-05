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
  type AnalyticsOverview,
  type AnalyticsPatterns,
  type AnalyticsProcess,
  type AnalyticsQuery,
} from '@sgr-registry/contracts';
import { Prisma } from '@sgr-registry/database';
import {
  ANALYTICS_DRILLDOWN_PAGE_SIZE,
  ANALYTICS_MIN_ORG_SAMPLE,
  MISSING_ANALYTICS_DIMENSIONS,
  SHARE_WITHOUT_EXPOSURE_LABEL,
  ValidationError,
  assertAnalyticsRange,
  durationStats,
  firstTimeRight,
  formatCoverage,
  hasCapability,
  organizationQualityIndex,
  ratio,
  reworkRate,
  riskScore,
  satisfiesCapability,
  signalDisplayLabel,
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
      companyActualCostByn: ctx.financial ? await this.moneySum(where, 'COMPANY') : null,
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
      topOrganizations: orgs.map((row) => ({
        organizationId: row.id,
        name: row.name,
        amountByn: row.amount,
      })),
      financialVisible: ctx.financial,
      crossOrganizationVisible: ctx.cross,
      canReviewInsights: ctx.review,
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
      perDefect,
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
      this.many<{ amount: string }>(Prisma.sql`
          SELECT sum(impact."amountByn")::text AS amount
          ${scopedFrom(
            where,
            Prisma.sql`JOIN public.defect_financial_impacts impact ON impact."defectItemId" = d.id
              AND impact.status::text = 'CONFIRMED'
              AND impact."amountType"::text = 'ACTUAL_COST'
              AND impact."payerType"::text = 'COMPANY'`,
          )}
          GROUP BY d.id
        `),
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
    const amounts = perDefect
      .map((row) => Number(row.amount))
      .filter((value) => Number.isFinite(value));
    const stats = durationStats(amounts);
    return {
      companyActualCostByn: company,
      liableActualCostByn: liable,
      recoveryByn: recovery,
      avoidedLossByn: avoided,
      reworkCostByn: rework,
      meanDefectCostByn: stats.mean == null ? null : stats.mean.toFixed(2),
      medianDefectCostByn: stats.median == null ? null : stats.median.toFixed(2),
      costSampleSize: amounts.length,
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
      where: { scopeFingerprint: stamp.fingerprint, active: true },
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
      missingFinancialData: ctx.financial ? num(row?.missing_financial) : total,
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
      ],
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
    await this.prisma.$executeRaw`SELECT set_config('statement_timeout', '4000', true)`;
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
    const rows = await this.many<{
      id: string;
      act_id: string;
      label: string;
      age_days: number | null;
      overdue: boolean | null;
      rejections: number | null;
      has_liable: boolean;
      has_responsible: boolean;
      cost: string | null;
      type_count: number | null;
    }>(Prisma.sql`
      SELECT d.id::text AS id, a.id::text AS act_id,
             coalesce(d.location, dt.name) AS label,
             EXTRACT(EPOCH FROM (now() - d."createdAt")) / 86400 AS age_days,
             CASE WHEN d."effectiveDeadline" IS NULL THEN NULL
                  ELSE d."effectiveDeadline" < now() END AS overdue,
             CASE WHEN EXISTS (SELECT 1 FROM public.defect_inspection_attempts attempt WHERE attempt."defectItemId" = d.id)
                  THEN (SELECT count(*) FROM public.defect_inspection_attempts attempt WHERE attempt."defectItemId" = d.id AND attempt.status::text = 'REJECTED')
                  ELSE NULL END AS rejections,
             EXISTS (SELECT 1 FROM public.defect_item_liable_organizations liable WHERE liable."defectItemId" = d.id) AS has_liable,
             EXISTS (SELECT 1 FROM public.defect_item_engineers engineer WHERE engineer."defectItemId" = d.id) AS has_responsible,
             (
               SELECT sum(impact."amountByn")::text FROM public.defect_financial_impacts impact
               WHERE impact."defectItemId" = d.id AND impact.status::text = 'CONFIRMED'
                 AND impact."amountType"::text = 'ACTUAL_COST' AND impact."payerType"::text = 'COMPANY'
             ) AS cost,
             (
               SELECT count(*) FROM public.defect_items peer
               WHERE peer."defectTypeId" = d."defectTypeId"
             ) AS type_count
      ${scopedFrom(where, Prisma.sql`JOIN public.defect_types dt ON dt.id = d."defectTypeId"`)}
      AND d.status::text <> 'COMPLETED'
      ORDER BY d."createdAt" ASC
      LIMIT 200
    `);
    return rows
      .map((row) => ({
        defectItemId: row.id,
        actId: row.act_id,
        label: row.label,
        score: riskScore({
          ageDays: numOrNull(row.age_days),
          overdue: row.overdue,
          rejectionCount: row.rejections == null ? null : num(row.rejections),
          hasLiableOrganization: row.has_liable,
          hasResponsible: row.has_responsible,
          severity: null,
          confirmedCostByn: row.cost,
          defectTypeRepeatCount: row.type_count == null ? null : num(row.type_count),
        }).score,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);
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
