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
import {
  confirmedExposureSql,
  dropAnalyticsScopeSql,
  indexAnalyticsScopeSql,
  invalidTemporalPredicate,
  matchingInsightIdsSql,
  materializeAnalyticsScopeSql,
  overviewBundleSql,
  processClocksSql,
  riskWeightedBacklogSql,
  supportDrilldownSql,
  topRisksSql,
  Prisma,
} from '@sgr-registry/database';
import {
  ANALYTICS_DRILLDOWN_PAGE_SIZE,
  ANALYTICS_INSPECTION_WAIT_DAYS,
  ANALYTICS_MIN_ORG_SAMPLE,
  BACKLOG_RISK_FORMULA_VERSION,
  MISSING_ANALYTICS_DIMENSIONS,
  SHARE_WITHOUT_EXPOSURE_LABEL,
  UNAVAILABLE_METRIC_TEXT,
  ValidationError,
  assertAnalyticsRange,
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
import {
  analyticsDefectWhere,
  scopedFrom,
  withMaterializedAnalyticsScope,
} from './analytics-filter.js';
import {
  analyticsScopeStamp,
  isInsightSnapshotConflict,
  refreshAnalyticsPatterns,
} from './analytics-patterns.js';

@Injectable()
export class AnalyticsService {
  constructor(@Inject(PrismaService) private readonly prismaService: PrismaService) {}

  private get prisma() {
    return this.prismaService.client;
  }

  async overview(user: AuthenticatedUser, raw: unknown): Promise<AnalyticsOverview> {
    const ctx = await this.context(user, raw);
    const where = ctx.where;
    return this.withFilteredScope(where, analyticsStaffRole(user.role), async () => {
      await this.refresh(ctx);
      const row = await this.one<{ payload: unknown }>(
        overviewBundleSql({
          closureFrom: ctx.query.dateFrom
            ? new Date(`${ctx.query.dateFrom}T00:00:00.000+03:00`)
            : null,
          closureTo: ctx.query.dateTo ? new Date(`${ctx.query.dateTo}T23:59:59.999+03:00`) : null,
          scopeFingerprint: analyticsScopeStamp(ctx.scope).fingerprint,
          excludedTypes: hiddenSignalTypes(ctx),
          financial: ctx.financial,
          crossOrganization: ctx.cross,
        }),
      );
      const payload = overviewPayload(row?.payload);
      const draftCount = await this.one<{ n: number }>(
        Prisma.sql`SELECT count(*)::int AS n FROM public.acts WHERE status::text = 'NEW'`,
      );
      const attempts = firstTimeRight({
        completedAcceptedOnFirstAttempt: num(payload.accepted_first),
        completedWithAttempts: num(payload.with_attempts),
        completedDefects: num(payload.completed),
      });
      const order = ['0–3', '4–7', '8–14', '15–30', '31–60', '60+'];
      const exposure = exposureFromPayload(payload, ctx.query);
      const backlog = backlogFromPayload(payload);
      return {
        filters: ctx.query,
        acts: num(payload.acts),
        unfinishedDrafts: num(draftCount?.n),
        defects: num(payload.defects),
        openDefects: num(payload.open_defects),
        overdueDefects: num(payload.overdue_defects),
        noResponsible: num(payload.no_responsible),
        noLiableOrganization: num(payload.no_liable),
        noMovement: num(payload.no_movement),
        closedInPeriod: num(payload.closed_in_period),
        medianClosureMs: numOrNull(payload.median),
        p90ClosureMs: numOrNull(payload.p90),
        closureSampleSize: num(payload.closure_sample),
        firstTimeRight: {
          numerator: attempts.numerator,
          denominator: attempts.denominator,
          rate: attempts.rate,
          coverageText: formatCoverage(attempts.coverageNumerator, attempts.coverageDenominator),
        },
        averageAttempts: ratio(num(payload.attempt_sum), num(payload.attempt_defects)),
        newInsights: num(payload.new_insights),
        openedClosed: payload.series.map((point) => ({
          period: String(point.period),
          opened: num(point.opened),
          closed: num(point.closed),
        })),
        backlogAge: order.map((bucket) => ({
          bucket,
          count: num(payload.aging.find((item) => item.bucket === bucket)?.count),
        })),
        topRisks: payload.top_risks.map((item) => ({
          defectItemId: String(item.id),
          actId: String(item.act_id),
          label: String(item.label ?? ''),
          score: String(item.score),
        })),
        financialVisible: ctx.financial,
        crossOrganizationVisible: ctx.cross,
        canReviewInsights: ctx.review,
        ...(ctx.financial
          ? {
              companyActualCostByn: payload.company_cost,
              topOrganizations: payload.top_organizations.map((item) => ({
                organizationId: String(item.id),
                name: String(item.name),
                amountByn: String(item.amount),
              })),
              confirmedFinancialExposure: exposure,
              riskWeightedOpenBacklog: backlog,
            }
          : {}),
      };
    });
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
               WHERE scoped.status = 'COMPLETED'
                 AND scoped.ready_at IS NOT NULL
                 AND scoped.ready_at >= scoped.created_at
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
      }>(processClocksSql(ctx.where)),
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
    return this.withFilteredScope(ctx.where, analyticsStaffRole(user.role), async () => {
      await this.refresh(ctx);
      const stamp = analyticsScopeStamp(ctx.scope);
      const matched = await this.many<{ id: string }>(
        matchingInsightIdsSql(stamp.fingerprint, ctx.where, hiddenSignalTypes(ctx)),
      );
      const rows =
        matched.length === 0
          ? []
          : await this.prisma.analyticsInsight.findMany({
              where: { id: { in: matched.map((row) => row.id) } },
              orderBy: [{ supportCount: 'desc' }, { generatedAt: 'desc' }],
              take: 50,
              include: { reviewedBy: { select: { fullName: true } } },
            });
      return {
        items: rows.map((row) => ({
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
    });
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
      invalid_temporal: number;
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
        ))::int AS unresolved,
        count(*) FILTER (WHERE ${invalidTemporalPredicate})::int AS invalid_temporal
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
      invalidTemporalRecords: num(row?.invalid_temporal),
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
          metric: 'temporalOrder',
          label: 'Корректная последовательность событий',
          ...covered(num(row?.invalid_temporal)),
        },
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
      unavailableReason: insight.supportAvailable ? null : 'Снимок исходных дефектов недоступен',
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
    }>(
      supportDrilldownSql({
        insightId,
        where,
        order,
        direction: directionSql,
        pageSize,
        offset: (page - 1) * pageSize,
        includeOrganizations: cross || scope.organizationScoped,
      }),
    );
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
      label: string | null;
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
                   NULL::text AS label,
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
                   coalesce(nullif(d.location, ''), '') AS label,
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
        label: row.label,
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

  private async withFilteredScope<T>(
    where: Prisma.Sql,
    staff: boolean,
    run: () => Promise<T>,
  ): Promise<T> {
    await this.prisma.$executeRaw(dropAnalyticsScopeSql());
    await this.prisma.$executeRaw(materializeAnalyticsScopeSql(where, staff));
    await this.prisma.$executeRaw(indexAnalyticsScopeSql());
    await this.prisma.$executeRaw`ANALYZE analytics_scope_defects`;
    return withMaterializedAnalyticsScope(run);
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
    const persist = () =>
      refreshAnalyticsPatterns((query) => this.prisma.$queryRaw(query), this.prisma, {
        where: ctx.where,
        query: ctx.query,
        scope: ctx.scope,
        financial: ctx.financial,
        crossOrganization: ctx.cross,
      });
    try {
      await persist();
    } catch (error) {
      if (!isInsightSnapshotConflict(error)) {
        throw error;
      }
      try {
        await this.prisma.$executeRaw(Prisma.sql`ROLLBACK`);
      } catch {
        // The failed statement may already have ended the transaction.
      }
      await persist();
    }
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
      topRisksSql(where),
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
      confirmedExposureSql(where),
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
    }>(riskWeightedBacklogSql(where));
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

interface OverviewBundle {
  acts: number;
  defects: number;
  open_defects: number;
  overdue_defects: number;
  no_responsible: number;
  no_liable: number;
  no_movement: number;
  closed_in_period: number;
  median: number | null;
  p90: number | null;
  closure_sample: number;
  accepted_first: number;
  with_attempts: number;
  completed: number;
  attempt_sum: number;
  attempt_defects: number;
  new_insights: number;
  series: Array<{ period: string; opened: number; closed: number }>;
  aging: Array<{ bucket: string; count: number }>;
  top_risks: Array<{ id: string; act_id: string; label: string | null; score: string }>;
  company_cost: string | null;
  gross: string | null;
  recovery: string | null;
  exposure_records: number;
  backlog_open: number;
  backlog_evaluated: number;
  backlog_unweighted: string | null;
  backlog_weighted: string | null;
  top_organizations: Array<{ id: string; name: string; amount: string }>;
}

function overviewPayload(value: unknown): OverviewBundle {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  const payload = (parsed ?? {}) as Partial<OverviewBundle>;
  return {
    acts: payload.acts ?? 0,
    defects: payload.defects ?? 0,
    open_defects: payload.open_defects ?? 0,
    overdue_defects: payload.overdue_defects ?? 0,
    no_responsible: payload.no_responsible ?? 0,
    no_liable: payload.no_liable ?? 0,
    no_movement: payload.no_movement ?? 0,
    closed_in_period: payload.closed_in_period ?? 0,
    median: payload.median ?? null,
    p90: payload.p90 ?? null,
    closure_sample: payload.closure_sample ?? 0,
    accepted_first: payload.accepted_first ?? 0,
    with_attempts: payload.with_attempts ?? 0,
    completed: payload.completed ?? 0,
    attempt_sum: payload.attempt_sum ?? 0,
    attempt_defects: payload.attempt_defects ?? 0,
    new_insights: payload.new_insights ?? 0,
    series: Array.isArray(payload.series) ? payload.series : [],
    aging: Array.isArray(payload.aging) ? payload.aging : [],
    top_risks: Array.isArray(payload.top_risks) ? payload.top_risks : [],
    company_cost: payload.company_cost ?? null,
    gross: payload.gross ?? null,
    recovery: payload.recovery ?? null,
    exposure_records: payload.exposure_records ?? 0,
    backlog_open: payload.backlog_open ?? 0,
    backlog_evaluated: payload.backlog_evaluated ?? 0,
    backlog_unweighted: payload.backlog_unweighted ?? null,
    backlog_weighted: payload.backlog_weighted ?? null,
    top_organizations: Array.isArray(payload.top_organizations) ? payload.top_organizations : [],
  };
}

function exposureFromPayload(
  payload: OverviewBundle,
  query: AnalyticsQuery,
): NonNullable<AnalyticsOverview['confirmedFinancialExposure']> {
  const records = num(payload.exposure_records);
  if (records === 0 || (payload.gross == null && payload.recovery == null)) {
    return {
      available: false,
      currency: 'BYN',
      periodFrom: query.dateFrom ?? null,
      periodTo: query.dateTo ?? null,
      recordCount: 0,
    };
  }
  const gross = payload.gross ?? '0.00';
  const recovery = payload.recovery ?? '0.00';
  return {
    available: true,
    currency: 'BYN',
    grossCompanyCostByn: gross,
    confirmedRecoveryByn: recovery,
    netConfirmedExposureByn: subtractMoney(gross, recovery),
    recordCount: records,
    periodFrom: query.dateFrom ?? null,
    periodTo: query.dateTo ?? null,
  };
}

function backlogFromPayload(payload: OverviewBundle) {
  const openDefects = num(payload.backlog_open);
  const evaluated = num(payload.backlog_evaluated);
  return {
    available: evaluated > 0,
    weightedByn: evaluated > 0 ? payload.backlog_weighted : null,
    unweightedByn: evaluated > 0 ? payload.backlog_unweighted : null,
    evaluatedDefects: evaluated,
    openDefects,
    monetaryCoverage: openDefects === 0 ? null : evaluated / openDefects,
    formulaVersion: BACKLOG_RISK_FORMULA_VERSION,
    calculatedAt: new Date().toISOString(),
    inspectionWaitDays: ANALYTICS_INSPECTION_WAIT_DAYS,
  };
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
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function analyticsStaffRole(role: string): boolean {
  return role === 'ADMIN' || role === 'MANAGER' || role === 'SGR_MANAGER';
}

function hiddenSignalTypes(ctx: { financial: boolean; cross: boolean }): string[] {
  return [
    ...(ctx.financial ? [] : ['COST_CONCENTRATION']),
    ...(ctx.cross ? [] : ['INSPECTION_BOTTLENECK']),
  ];
}
