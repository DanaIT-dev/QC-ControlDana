import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import type { AnalyticsQuery } from '@sgr-registry/contracts';
import { CONFIRMED_LAST_FIRST_TOKEN_ORDER, personNameWriteFields } from '@sgr-registry/domain';
import {
  refreshAnalyticsPatterns,
  scopedFrom,
  withMaterializedAnalyticsScope,
} from '../../../../apps/api/src/analytics/analytics-patterns.js';
import {
  confirmedExposureSql,
  createOwnerPrismaClient,
  createPrismaClient,
  dropAnalyticsScopeSql,
  explainStatement,
  indexAnalyticsScopeSql,
  invalidTemporalCountSql,
  lowFirstTimeRightSql,
  matchingInsightIdsSql,
  materializeAnalyticsScopeSql,
  newInsightsCountSql,
  overviewBundleSql,
  overviewClosureSql,
  overviewCountsSql,
  processClocksSql,
  riskWeightedBacklogSql,
  signUserRlsContext,
  statementFingerprint,
  supportDrilldownSql,
  topRisksSql,
  withAuthenticatedDbContext,
} from '../../src/index';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';

const migratorUrl = process.env.MIGRATION_DATABASE_URL ?? '';
const appUrl = process.env.DATABASE_URL ?? '';
const secret = process.env.RLS_CONTEXT_SECRET ?? '';
assertSafeTestDatabaseUrl(migratorUrl);
assertSafeTestDatabaseUrl(appUrl);

const owner = createOwnerPrismaClient(migratorUrl);
const app = createPrismaClient(appUrl);
const marker = `qa-${randomUUID().slice(0, 8)}`;

let adminId = '';
let contractorId = '';
let superAdminId = '';
let objectId = '';
let organizationId = '';
let otherOrganizationId = '';
let defectTypeId = '';
let actId = '';
let defectId = '';

async function user(role: 'ADMIN' | 'CONTRACTOR_ENGINEER' | 'SUPER_ADMIN', email: string) {
  return owner.user.create({
    data: {
      ...personNameWriteFields(`${marker} ${role}`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
      email,
      role,
      sessionVersion: 1,
    },
  });
}

describe('quality analytics invariants', () => {
  beforeAll(async () => {
    expect(secret.length).toBeGreaterThanOrEqual(32);
    const admin = await user('ADMIN', `${marker}.admin@example.sgr.local`);
    adminId = admin.id;
    const contractor = await user('CONTRACTOR_ENGINEER', `${marker}.contractor@example.sgr.local`);
    contractorId = contractor.id;
    const existingSuperAdmin = await owner.user.findFirst({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
      select: { id: true },
    });
    superAdminId = existingSuperAdmin
      ? existingSuperAdmin.id
      : (
          await owner.user.create({
            data: {
              ...personNameWriteFields(`${marker} SUPER_ADMIN`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
              email: `${marker}.super@example.sgr.local`,
              role: 'SUPER_ADMIN',
              sessionVersion: 1,
            },
          })
        ).id;
    const object = await owner.propertyObject.create({
      data: { name: `${marker} object`, address: 'Минск' },
    });
    objectId = object.id;
    const organization = await owner.organization.create({
      data: {
        officialName: `${marker} liable`,
        postalAddress: 'addr',
        email: `${marker}.org@example.sgr.local`,
        phone: '1',
        contactPerson: 'П',
      },
    });
    const other = await owner.organization.create({
      data: {
        officialName: `${marker} other`,
        postalAddress: 'addr',
        email: `${marker}.other@example.sgr.local`,
        phone: '1',
        contactPerson: 'Д',
      },
    });
    organizationId = organization.id;
    otherOrganizationId = other.id;
    const defectType = await owner.defectType.create({
      data: { code: marker.toUpperCase(), name: marker, sortOrder: 90 },
    });
    defectTypeId = defectType.id;
    const act = await owner.act.create({
      data: {
        formCode: 'S1',
        year: 2099,
        sequence: Math.floor(Math.random() * 1_000_000) + 1,
        objectId,
        customerOrganizationId: organizationId,
        issuedOn: new Date('2026-03-01T00:00:00.000Z'),
        status: 'IN_PROGRESS',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        startedAt: new Date('2026-03-01T00:00:00.000Z'),
        officialNumber: marker,
      },
    });
    actId = act.id;
    const defect = await owner.defectItem.create({
      data: {
        actId,
        defectTypeId,
        status: 'IN_PROGRESS',
        location: 'Секция',
        claimDetails: marker,
      },
    });
    defectId = defect.id;
    await owner.defectItemLiableOrganization.create({
      data: { defectItemId: defectId, organizationId },
    });
    await owner.userOrganizationMembership.create({
      data: { userId: contractorId, organizationId, assignedByUserId: adminId },
    });
  });

  afterAll(async () => {
    await owner.$executeRaw`ALTER TABLE public.defect_financial_impacts DISABLE TRIGGER defect_financial_impacts_guard`;
    await owner.defectFinancialImpact
      .deleteMany({ where: { defectItemId: defectId } })
      .catch(() => undefined);
    await owner.$executeRaw`ALTER TABLE public.defect_financial_impacts ENABLE TRIGGER defect_financial_impacts_guard`;
    await owner.$executeRaw`ALTER TABLE public.defect_inspection_attempts DISABLE TRIGGER defect_inspection_attempts_guard`;
    await owner.defectInspectionAttempt
      .deleteMany({ where: { defectItemId: defectId } })
      .catch(() => undefined);
    await owner.$executeRaw`ALTER TABLE public.defect_inspection_attempts ENABLE TRIGGER defect_inspection_attempts_guard`;
    await owner.defectItemLiableOrganization
      .deleteMany({ where: { defectItemId: defectId } })
      .catch(() => undefined);
    await owner.defectItem.deleteMany({ where: { actId } }).catch(() => undefined);
    await owner.act.deleteMany({ where: { id: actId } }).catch(() => undefined);
    await owner.userOrganizationMembership
      .deleteMany({ where: { userId: contractorId } })
      .catch(() => undefined);
    await owner.organization
      .deleteMany({ where: { id: { in: [organizationId, otherOrganizationId] } } })
      .catch(() => undefined);
    await owner.propertyObject.deleteMany({ where: { id: objectId } }).catch(() => undefined);
    await owner.defectType.deleteMany({ where: { id: defectTypeId } }).catch(() => undefined);
    await owner.user
      .deleteMany({ where: { id: { in: [adminId, contractorId] } } })
      .catch(() => undefined);
    await owner.$disconnect();
    await app.$disconnect();
  });

  it('keeps one pending attempt and refuses to delete or rewrite a closed attempt', async () => {
    const first = await owner.defectInspectionAttempt.create({
      data: {
        defectItemId: defectId,
        attemptNumber: 1,
        status: 'PENDING',
        submittedByUserId: contractorId,
        submittedAt: new Date('2026-04-01T09:00:00.000Z'),
      },
    });
    await expect(
      owner.defectInspectionAttempt.create({
        data: {
          defectItemId: defectId,
          attemptNumber: 2,
          status: 'PENDING',
          submittedByUserId: contractorId,
          submittedAt: new Date('2026-04-02T09:00:00.000Z'),
        },
      }),
    ).rejects.toThrow(/unique|pending/i);
    await owner.defectInspectionAttempt.update({
      where: { id: first.id },
      data: {
        status: 'ACCEPTED',
        reviewedByUserId: adminId,
        reviewedAt: new Date('2026-04-03T09:00:00.000Z'),
      },
    });
    await expect(
      owner.defectInspectionAttempt.update({
        where: { id: first.id },
        data: { status: 'REJECTED', rejectionReason: 'повтор' },
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      withAuthenticatedDbContext({
        prisma: app,
        secret,
        user: { id: adminId, sessionVersion: 1 },
        callback: (tx) => tx.defectInspectionAttempt.delete({ where: { id: first.id } }),
      }),
    ).rejects.toThrow(/cannot be deleted|permission denied|denied/i);
  });

  it('keeps a confirmed financial record immutable and hides it from a contractor', async () => {
    const impact = await owner.defectFinancialImpact.create({
      data: {
        defectItemId: defectId,
        amountType: 'ACTUAL_COST',
        payerType: 'COMPANY',
        amountOriginal: '10.00',
        currency: 'BYN',
        exchangeRateToByn: '1.000000',
        amountByn: '10.00',
        occurredAt: new Date('2026-04-04T09:00:00.000Z'),
        status: 'CONFIRMED',
        source: 'MANUAL',
        createdByUserId: adminId,
        confirmedByUserId: adminId,
        confirmedAt: new Date('2026-04-04T10:00:00.000Z'),
      },
    });
    await expect(
      owner.defectFinancialImpact.update({
        where: { id: impact.id },
        data: { amountByn: '11.00' },
      }),
    ).rejects.toThrow(/immutable/i);
    const contractorRows = await withAuthenticatedDbContext({
      prisma: app,
      secret,
      user: { id: contractorId, sessionVersion: 1 },
      callback: (tx) => tx.defectFinancialImpact.findMany({ where: { id: impact.id } }),
    });
    expect(contractorRows).toEqual([]);
    const superRows = await withAuthenticatedDbContext({
      prisma: app,
      secret,
      user: { id: superAdminId, sessionVersion: 1 },
      callback: (tx) => tx.defectFinancialImpact.findMany({ where: { id: impact.id } }),
    });
    expect(superRows).toHaveLength(1);
    await expect(
      withAuthenticatedDbContext({
        prisma: app,
        secret,
        user: { id: superAdminId, sessionVersion: 1 },
        callback: (tx) =>
          tx.defectFinancialImpact.update({
            where: { id: impact.id },
            data: { comment: 'правка' },
          }),
      }),
    ).rejects.toThrow();
  });

  it('does not let the application role invent work exposure', async () => {
    await expect(
      withAuthenticatedDbContext({
        prisma: app,
        secret,
        user: { id: adminId, sessionVersion: 1 },
        callback: (tx) =>
          tx.workExposure.create({
            data: {
              organizationId,
              exposureType: 'AREA',
              exposureValue: '1',
              unit: 'м2',
              periodFrom: new Date('2026-01-01T00:00:00.000Z'),
              periodTo: new Date('2026-01-31T00:00:00.000Z'),
              source: 'TEST',
            },
          }),
      }),
    ).rejects.toThrow();
  });

  it('rejects changes to a published support snapshot', async () => {
    const insight = await owner.analyticsInsight.create({
      data: {
        signalKey: `${marker}:support`,
        signalType: 'LOW_FIRST_TIME_RIGHT',
        title: 'проверка',
        plainLanguageExplanation: 'Наблюдается связь.',
        dimensions: [{ key: 'liableOrganization', value: organizationId, label: marker }],
        supportCount: 1,
        totalCount: 2,
        observedValue: '0.100000',
        baselineValue: '0.800000',
        confidence: 'low',
        generatedAt: new Date('2026-06-01T00:00:00.000Z'),
        ruleVersion: '2026.10.05.2',
        scopeKind: 'COMPANY',
        scopeFingerprint: 'company',
        filterSnapshot: { dateFrom: '2026-01-01' },
        filterHash: marker,
        snapshotHash: marker,
        supportAvailable: true,
      },
    });
    await owner.analyticsInsightDefect.create({
      data: {
        insightId: insight.id,
        defectItemId: defectId,
        contributionReason: 'сегмент',
        observedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    });
    await expect(
      owner.analyticsInsightDefect.create({
        data: {
          insightId: insight.id,
          defectItemId: defectId,
          contributionReason: 'повтор',
          observedAt: new Date('2026-06-01T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();
    await expect(
      owner.analyticsInsight.update({ where: { id: insight.id }, data: { supportCount: 2 } }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      withAuthenticatedDbContext({
        prisma: app,
        secret,
        user: { id: adminId, sessionVersion: 1 },
        callback: (tx) =>
          tx.analyticsInsightDefect.deleteMany({ where: { insightId: insight.id } }),
      }),
    ).rejects.toThrow(/cannot be deleted|permission denied|denied/i);
    const hidden = await withAuthenticatedDbContext({
      prisma: app,
      secret,
      user: { id: contractorId, sessionVersion: 1 },
      callback: (tx) => tx.analyticsInsightDefect.findMany({ where: { insightId: insight.id } }),
    });
    expect(hidden).toEqual([]);
  });

  it('uses the created-at index for a large defect population', async () => {
    await owner.$executeRaw`ALTER TABLE public.defect_items DISABLE TRIGGER trg_sgr_refresh_act_status_from_defects`;
    try {
      await owner.$executeRaw`
        INSERT INTO public.defect_items (id, "actId", "defectTypeId", status, location, "claimDetails", "createdAt", "updatedAt")
        SELECT gen_random_uuid(), ${actId}::uuid, ${defectTypeId}::uuid, 'IN_PROGRESS'::"DefectItemStatus", 'Синтетика', 'Синтетика',
               TIMESTAMPTZ '2020-01-01 00:00:00+00', TIMESTAMPTZ '2020-01-01 00:00:00+00'
        FROM generate_series(1, 100000)
      `;
      const riskyId = randomUUID();
      await owner.$executeRaw`
        INSERT INTO public.defect_items (id, "actId", "defectTypeId", status, location, "claimDetails", "claimDeadline", "createdAt", "updatedAt")
        VALUES (
          ${riskyId}::uuid, ${actId}::uuid, ${defectTypeId}::uuid, 'IN_PROGRESS'::"DefectItemStatus",
          'Риск', 'Риск', TIMESTAMPTZ '2020-01-02 00:00:00+00', now(), now()
        )
      `;
      await owner.$executeRaw`
        INSERT INTO public.defect_inspection_attempts (
          id, "defectItemId", "attemptNumber", status, "submittedByUserId", "submittedAt", "reviewedByUserId", "reviewedAt", "rejectionReason", "createdAt", "updatedAt"
        )
        SELECT gen_random_uuid(), d.id, 1, 'REJECTED'::"InspectionAttemptStatus", ${adminId}::uuid, now(), ${adminId}::uuid, now(), 'повтор', now(), now()
        FROM (
          SELECT id FROM public.defect_items WHERE "actId" = ${actId}::uuid AND id <> ${defectId}::uuid ORDER BY "createdAt" LIMIT 10000
        ) d
      `;
      await owner.$executeRaw`
        INSERT INTO public.defect_inspection_attempts (
          id, "defectItemId", "attemptNumber", status, "submittedByUserId", "submittedAt", "reviewedByUserId", "reviewedAt", "rejectionReason", "createdAt", "updatedAt"
        )
        SELECT gen_random_uuid(), ${riskyId}::uuid, attempt_number, 'REJECTED'::"InspectionAttemptStatus",
               ${adminId}::uuid, now(), ${adminId}::uuid, now(), 'повтор', now(), now()
        FROM generate_series(1, 4) AS attempt_number
      `;
      await owner.$executeRaw`
        INSERT INTO public.defect_financial_impacts (
          id, "defectItemId", "amountType", "payerType", "amountOriginal", currency, "exchangeRateToByn", "amountByn",
          "occurredAt", status, source, "createdByUserId", "confirmedByUserId", "confirmedAt", "createdAt", "updatedAt"
        )
        SELECT gen_random_uuid(), d.id, 'ACTUAL_COST'::"FinancialAmountType", 'COMPANY'::"FinancialPayerType",
               10.55, 'BYN', 1, 10.55, now(), 'CONFIRMED'::"FinancialRecordStatus", 'SYNTHETIC',
               ${adminId}::uuid, ${adminId}::uuid, now(), now(), now()
        FROM (
          SELECT id FROM public.defect_items WHERE "actId" = ${actId}::uuid AND id <> ${defectId}::uuid AND id <> ${riskyId}::uuid
          ORDER BY "createdAt" OFFSET 10000 LIMIT 10000
        ) d
      `;
      await owner.$executeRaw`
        INSERT INTO public.defect_financial_impacts (
          id, "defectItemId", "amountType", "payerType", "amountOriginal", currency, "exchangeRateToByn", "amountByn",
          "occurredAt", status, source, "createdByUserId", "confirmedByUserId", "confirmedAt", "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid(), ${riskyId}::uuid, 'ACTUAL_COST'::"FinancialAmountType", 'COMPANY'::"FinancialPayerType",
          1000000.00, 'BYN', 1, 1000000.00, now(), 'CONFIRMED'::"FinancialRecordStatus", 'SYNTHETIC',
          ${adminId}::uuid, ${adminId}::uuid, now(), now(), now()
        )
      `;
      const insight = await owner.analyticsInsight.create({
        data: {
          signalKey: `${marker}:perf`,
          signalType: 'DATA_QUALITY_RISK',
          title: 'perf',
          plainLanguageExplanation: 'Наблюдается связь.',
          dimensions: [],
          supportCount: 1000,
          totalCount: 1000,
          observedValue: '1',
          baselineValue: '1',
          confidence: 'low',
          generatedAt: new Date(),
          ruleVersion: '2026.10.05.2',
          scopeKind: 'COMPANY',
          scopeFingerprint: 'company',
          filterHash: marker,
          snapshotHash: `${marker}:perf`,
          supportAvailable: true,
        },
      });
      await owner.$executeRaw`
        INSERT INTO public.analytics_insight_defects (id, "insightId", "defectItemId", "contributionReason", "observedAt")
        SELECT gen_random_uuid(), ${insight.id}::uuid, d.id, 'синтетика', now()
        FROM (
          SELECT id FROM public.defect_items WHERE "actId" = ${actId}::uuid ORDER BY "createdAt" LIMIT 1000
        ) d
      `;
      const workType = await owner.workType.create({
        data: { code: marker.slice(0, 20), name: marker, sortOrder: 4 },
      });
      const otherType = await owner.defectType.create({
        data: {
          code: `${marker}-b`.slice(0, 24).toUpperCase(),
          name: `${marker} b`,
          sortOrder: 91,
        },
      });
      const otherObject = await owner.propertyObject.create({
        data: { name: `${marker} object 2`, address: 'Минск' },
      });
      const otherAct = await owner.act.create({
        data: {
          formCode: 'S1',
          year: 2098,
          sequence: Math.floor(Math.random() * 800_000) + 100_000,
          objectId: otherObject.id,
          customerOrganizationId: otherOrganizationId,
          issuedOn: new Date('2020-01-01T00:00:00.000Z'),
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
          status: 'IN_PROGRESS',
          startedAt: new Date('2020-01-01T00:00:00.000Z'),
          officialNumber: `${marker}-b`,
        },
      });
      await owner.$executeRaw`
        UPDATE public.defect_items
        SET "workTypeId" = ${workType.id}::uuid
        WHERE id IN (
          SELECT id FROM public.defect_items
          WHERE "actId" = ${actId}::uuid
          ORDER BY "createdAt" DESC
          LIMIT 2000
        )
      `;
      await owner.$executeRaw`
        UPDATE public.defect_items
        SET "defectTypeId" = ${otherType.id}::uuid, "actId" = ${otherAct.id}::uuid
        WHERE id IN (
          SELECT id FROM public.defect_items
          WHERE "actId" = ${actId}::uuid AND id <> ${defectId}::uuid AND id <> ${riskyId}::uuid
          ORDER BY "createdAt" DESC
          OFFSET 2000
          LIMIT 2000
        )
      `;
      await owner.$executeRaw`
        UPDATE public.defect_items
        SET status = 'COMPLETED'::"DefectItemStatus",
            "readyAt" = "createdAt" + interval '10 days'
        WHERE id IN (
          SELECT id FROM public.defect_items
          WHERE "actId" = ${actId}::uuid AND id <> ${defectId}::uuid AND id <> ${riskyId}::uuid
          ORDER BY "createdAt"
          OFFSET 20000
          LIMIT 2000
        )
      `;
      await owner.$executeRaw`
        INSERT INTO public.defect_item_liable_organizations ("defectItemId", "organizationId")
        SELECT id, ${organizationId}::uuid
        FROM public.defect_items
        WHERE "actId" = ${actId}::uuid AND id <> ${defectId}::uuid
        ORDER BY "createdAt"
        LIMIT 5000
        ON CONFLICT DO NOTHING
      `;
      await owner.$executeRaw`
        INSERT INTO public.defect_financial_impacts (
          id, "defectItemId", "amountType", "payerType", "amountOriginal", currency, "exchangeRateToByn", "amountByn",
          "occurredAt", status, source, "createdByUserId", "confirmedByUserId", "confirmedAt", "createdAt", "updatedAt"
        )
        SELECT gen_random_uuid(), d.id, 'APPROVED_AMOUNT'::"FinancialAmountType", 'COMPANY'::"FinancialPayerType",
               20.00, 'BYN', 1, 20.00, now(), 'CONFIRMED'::"FinancialRecordStatus", 'SYNTHETIC',
               ${adminId}::uuid, ${adminId}::uuid, now(), now(), now()
        FROM (
          SELECT id FROM public.defect_items
          WHERE "actId" = ${actId}::uuid AND status::text <> 'COMPLETED' AND id <> ${riskyId}::uuid
          ORDER BY "createdAt"
          OFFSET 30000
          LIMIT 5000
        ) d
      `;
      await owner.$executeRaw`ALTER TABLE public.defect_items DROP CONSTRAINT IF EXISTS defect_items_ready_not_before_created`;
      await owner.$executeRaw`ALTER TABLE public.defect_inspection_attempts DISABLE TRIGGER defect_inspection_attempts_guard`;
      await owner.$executeRaw`ALTER TABLE public.defect_inspection_attempts DROP CONSTRAINT IF EXISTS defect_inspection_attempts_review_not_before_submit`;
      await owner.$executeRaw`
        UPDATE public.defect_items
        SET status = 'COMPLETED'::"DefectItemStatus",
            "readyAt" = "createdAt" - interval '2 days'
        WHERE id IN (
          SELECT id FROM public.defect_items
          WHERE "actId" = ${actId}::uuid AND id <> ${defectId}::uuid AND id <> ${riskyId}::uuid
          ORDER BY "createdAt"
          OFFSET 40000
          LIMIT 100
        )
      `;
      await owner.$executeRaw`
        UPDATE public.defect_inspection_attempts
        SET "reviewedAt" = "submittedAt" - interval '1 hour'
        WHERE id IN (
          SELECT attempt.id
          FROM public.defect_inspection_attempts attempt
          JOIN public.defect_items d ON d.id = attempt."defectItemId"
          WHERE d."actId" = ${actId}::uuid
          ORDER BY attempt."createdAt"
          LIMIT 50
        )
      `;
      await owner.$executeRaw`
        ALTER TABLE public.defect_items
        ADD CONSTRAINT defect_items_ready_not_before_created
        CHECK ("readyAt" IS NULL OR "readyAt" >= "createdAt") NOT VALID
      `;
      await owner.$executeRaw`
        ALTER TABLE public.defect_inspection_attempts
        ADD CONSTRAINT defect_inspection_attempts_review_not_before_submit
        CHECK ("reviewedAt" IS NULL OR "reviewedAt" >= "submittedAt") NOT VALID
      `;
      await owner.$executeRaw`ALTER TABLE public.defect_inspection_attempts ENABLE TRIGGER defect_inspection_attempts_guard`;
      await owner.$executeRawUnsafe('VACUUM (ANALYZE) public.defect_items');
      await owner.$executeRawUnsafe('VACUUM (ANALYZE) public.acts');
      await owner.$executeRawUnsafe('VACUUM (ANALYZE) public.defect_inspection_attempts');
      await owner.$executeRawUnsafe('VACUUM (ANALYZE) public.defect_financial_impacts');
      await owner.$executeRawUnsafe('VACUUM (ANALYZE) public.analytics_insight_defects');
      const plan = await owner.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
        EXPLAIN (ANALYZE, FORMAT TEXT)
        SELECT count(*)::int
        FROM public.defect_items d
        JOIN public.acts a ON a.id = d."actId"
        WHERE d."createdAt" >= ${new Date('2026-01-01T00:00:00.000+03:00')}
          AND d."actId" = ${actId}::uuid
      `;
      const text = plan.map((row) => row['QUERY PLAN']).join('\n');
      const match = /Execution Time: ([0-9.]+) ms/.exec(text);
      expect(match).not.toBeNull();
      expect(Number(match?.[1])).toBeLessThan(1500);
      const oldest = await owner.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id
        FROM public.defect_items
        WHERE "actId" = ${actId}::uuid
        ORDER BY "createdAt" ASC, id ASC
        LIMIT 200
      `;
      expect(oldest.map((row) => row.id)).not.toContain(riskyId);
      const token = signUserRlsContext({ userId: adminId, sessionVersion: 1 }, secret);
      const where = Prisma.sql`d."actId" IN (${actId}::uuid, ${otherAct.id}::uuid)`;
      const filtered = Prisma.sql`TRUE AND d."createdAt" >= ${new Date('2020-01-01T00:00:00.000Z')} AND d."createdAt" < ${new Date('2020-02-01T00:00:00.000Z')} AND a."objectId" = ${objectId}::uuid AND d."defectTypeId" = ${defectTypeId}::uuid AND d.status::text = 'IN_PROGRESS'`;
      const rankingTemplate = (
        topRisksSql(where) as Prisma.Sql & { strings: readonly string[] }
      ).strings.join('');
      expect(rankingTemplate.indexOf('LIMIT')).toBeGreaterThan(rankingTemplate.indexOf('AS score'));
      const openCte = rankingTemplate.slice(
        rankingTemplate.indexOf('open_defects AS ('),
        rankingTemplate.indexOf('attempts AS ('),
      );
      expect(openCte).not.toContain('LIMIT');
      const measured = await app.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('statement_timeout', '8000', true)`;
          await tx.$executeRaw`SELECT sgr_set_request_context(${token})`;
          const statements = {
            overviewCounts: overviewCountsSql(where, Prisma.empty),
            overviewClosure: overviewClosureSql(where),
            exposure: confirmedExposureSql(where),
            backlog: riskWeightedBacklogSql(where),
            process: processClocksSql(where),
            patterns: matchingInsightIdsSql('company', where),
            lowFirstTimeRight: lowFirstTimeRightSql(where),
            supportDrilldown: supportDrilldownSql({
              insightId: insight.id,
              where: Prisma.sql`TRUE`,
              order: Prisma.sql`d."createdAt"`,
              direction: Prisma.sql`DESC`,
              pageSize: 50,
              offset: 0,
              includeOrganizations: true,
            }),
            topRisks: topRisksSql(where),
            newInsights: newInsightsCountSql('company', filtered),
            invalidTemporal: invalidTemporalCountSql(where),
          };
          const statementRecords: Array<Record<string, unknown>> = [];
          for (const [name, sql] of Object.entries(statements)) {
            const fingerprint = statementFingerprint(sql);
            const started = Date.now();
            let rows: Array<Record<string, unknown>>;
            try {
              rows = await tx.$queryRaw<Array<Record<string, unknown>>>(sql);
            } catch (error) {
              const message = error instanceof Error ? error.message : 'query failed';
              throw new Error(`${name} failed: ${message}`, { cause: error });
            }
            const elapsedMs = Date.now() - started;
            const explained = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
              explainStatement(sql),
            );
            const planFingerprint = statementFingerprint(sql);
            if (planFingerprint !== fingerprint) {
              throw new Error(`plan fingerprint diverged for ${name}`);
            }
            const plan = explained[0]?.['QUERY PLAN'];
            const planText = JSON.stringify(plan);
            if (!planText.includes('Execution Time') && !planText.includes('Planning Time')) {
              throw new Error(`missing analyze plan for ${name}`);
            }
            statementRecords.push({
              name,
              elapsedMs,
              fingerprint,
              planFingerprint,
              rows: ['topRisks', 'invalidTemporal', 'backlog', 'newInsights'].includes(name)
                ? rows.slice(0, 1)
                : undefined,
              performanceRisk: elapsedMs > 2000,
              plan,
            });
          }
          const bundleSql = overviewBundleSql({
            closureFrom: null,
            closureTo: null,
            scopeFingerprint: 'company',
            excludedTypes: [],
            financial: true,
            crossOrganization: true,
          });
          const materializeSql = materializeAnalyticsScopeSql(where, true);
          const scope = {
            organizationScoped: false,
            objectScoped: false,
            organizationIds: [] as readonly string[],
            userId: adminId,
          };
          const runs: number[] = [];
          let payload: Record<string, unknown> = {};
          let serializationMs = 0;
          let responseBytes = 0;
          for (let run = 0; run < 6; run += 1) {
            const started = Date.now();
            let phase = 'materialize';
            try {
              await tx.$executeRaw(dropAnalyticsScopeSql());
              await tx.$executeRaw(materializeSql);
              await tx.$executeRaw(indexAnalyticsScopeSql());
              await tx.$executeRaw`ANALYZE analytics_scope_defects`;
              phase = 'probe';
              const probe = await withMaterializedAnalyticsScope(() =>
                tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>(
                  Prisma.sql`EXPLAIN SELECT count(*)::int ${scopedFrom(Prisma.sql`TRUE`)}`,
                ),
              );
              const probeText = probe.map((row) => row['QUERY PLAN']).join('\n');
              if (!probeText.includes('analytics_scope_defects')) {
                throw new Error(`scope probe missed the temp table: ${probeText}`);
              }
              phase = 'refresh';
              const refreshStarted = Date.now();
              await withMaterializedAnalyticsScope(() =>
                refreshAnalyticsPatterns((query) => tx.$queryRaw(query), tx, {
                  where,
                  query: {} as AnalyticsQuery,
                  scope: scope as never,
                  financial: true,
                  crossOrganization: true,
                }),
              );
              phase = 'bundle';
              const refreshMs = Date.now() - refreshStarted;
              const bundleStarted = Date.now();
              const rows =
                await tx.$queryRaw<Array<{ payload: Record<string, unknown> }>>(bundleSql);
              console.log(
                JSON.stringify({
                  run,
                  refreshMs,
                  bundleMs: Date.now() - bundleStarted,
                  totalMs: Date.now() - started,
                }),
              );
              payload = rows[0]?.payload ?? {};
              const serialStarted = Date.now();
              const body = JSON.stringify(payload);
              serializationMs = Date.now() - serialStarted;
              responseBytes = Buffer.byteLength(body);
              runs.push(Date.now() - started);
            } catch (error) {
              const message = error instanceof Error ? error.message : 'overview failed';
              throw new Error(
                `overview run ${run} phase ${phase} failed after ${Date.now() - started}ms: ${message}`,
                { cause: error },
              );
            }
          }
          const coldMs = runs[0] ?? 0;
          const warmMs = runs.slice(1);
          const overviewMs = percentile(warmMs, 50);
          const overviewP95Ms = percentile(warmMs, 95);
          const bundlePlan = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
            explainStatement(bundleSql),
          );
          await tx.$executeRaw(dropAnalyticsScopeSql());
          const materializePlan = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
            explainStatement(materializeSql),
          );
          const databaseMs =
            executionMs(materializePlan[0]?.['QUERY PLAN']) +
            executionMs(bundlePlan[0]?.['QUERY PLAN']);
          const materializeFingerprint = statementFingerprint(materializeSql);
          const bundleFingerprint = statementFingerprint(bundleSql);
          if (statementFingerprint(materializeSql) !== materializeFingerprint) {
            throw new Error('materialize plan fingerprint diverged');
          }
          if (statementFingerprint(bundleSql) !== bundleFingerprint) {
            throw new Error('bundle plan fingerprint diverged');
          }
          const records: Array<Record<string, unknown>> = [
            {
              name: 'overview',
              elapsedMs: overviewMs,
              coldMs,
              warmMs,
              p95Ms: overviewP95Ms,
              databaseMs,
              serializationMs,
              responseBytes,
              fingerprint: bundleFingerprint,
              planFingerprint: bundleFingerprint,
              materializeFingerprint,
              performanceRisk: overviewMs > 3000,
              plan: bundlePlan[0]?.['QUERY PLAN'],
              materializePlan: materializePlan[0]?.['QUERY PLAN'],
              defects: payload.defects,
              invalidTemporal: payload.invalid_temporal,
              topRiskId: Array.isArray(payload.top_risks)
                ? (payload.top_risks[0] as { id?: string } | undefined)?.id
                : undefined,
            },
            ...statementRecords,
          ];
          return {
            overviewMs,
            coldMs,
            warmMs,
            overviewP95Ms,
            databaseMs,
            serializationMs,
            responseBytes,
            records,
          };
        },
        { maxWait: 10_000, timeout: 360_000 },
      );
      const artifactDir = resolve(
        import.meta.dirname,
        '../../../../test-results/analytics-performance',
      );
      mkdirSync(artifactDir, { recursive: true });
      const manifest = measured.records.map((record) => {
        const plan = JSON.parse(
          JSON.stringify(record.plan ?? null).replace(
            /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
            '[redacted]',
          ),
        );
        if (record.fingerprint) {
          writeFileSync(
            resolve(artifactDir, `${record.name}.${record.fingerprint}.json`),
            JSON.stringify(
              {
                fingerprint: record.fingerprint,
                plan,
                materializeFingerprint: record.materializeFingerprint ?? null,
                materializePlan: record.materializePlan ?? null,
              },
              null,
              2,
            ),
          );
        }
        return {
          name: record.name,
          elapsedMs: record.elapsedMs,
          coldMs: record.coldMs,
          warmMs: record.warmMs,
          p95Ms: record.p95Ms,
          databaseMs: record.databaseMs,
          serializationMs: record.serializationMs,
          responseBytes: record.responseBytes,
          fingerprint: record.fingerprint,
          planFingerprint: record.planFingerprint,
          materializeFingerprint: record.materializeFingerprint,
          performanceRisk: record.performanceRisk ?? false,
        };
      });
      writeFileSync(
        resolve(artifactDir, 'manifest.json'),
        JSON.stringify(
          {
            role: 'sgr_app',
            statementTimeoutMs: 8000,
            preLimit: false,
            rls: true,
            overviewMs: measured.overviewMs,
            coldMs: measured.coldMs,
            warmMs: measured.warmMs,
            p95Ms: measured.overviewP95Ms,
            databaseMs: measured.databaseMs,
            serializationMs: measured.serializationMs,
            responseBytes: measured.responseBytes,
            queries: manifest,
          },
          null,
          2,
        ),
      );
      expect(measured.coldMs).toBeLessThan(8000);
      expect(measured.overviewMs).toBeLessThan(8000);
      expect(measured.overviewP95Ms).toBeLessThan(8000);
      for (const elapsed of measured.warmMs) {
        expect(elapsed).toBeLessThan(8000);
      }
      const overview = measured.records.find((record) => record.name === 'overview');
      expect(Number(overview?.defects)).toBeGreaterThanOrEqual(100_000);
      expect(overview?.topRiskId).toBe(riskyId);
      expect(Number(overview?.invalidTemporal)).toBeGreaterThan(0);
      const overviewPlan = JSON.stringify(overview?.plan ?? '');
      expect(overviewPlan).toContain('Execution Time');
      for (const record of manifest) {
        expect(record.elapsedMs).toBeLessThan(8000);
        if (record.fingerprint) {
          expect(record.planFingerprint).toBe(record.fingerprint);
        }
      }
      const top = measured.records.find((record) => record.name === 'topRisks');
      const topRow = (top?.rows as Array<{ id?: string }> | undefined)?.[0];
      expect(topRow?.id).toBe(riskyId);
      const invalid = measured.records.find((record) => record.name === 'invalidTemporal');
      expect(Number((invalid?.rows as Array<{ n?: number }> | undefined)?.[0]?.n)).toBeGreaterThan(
        0,
      );
      const backlog = measured.records.find((record) => record.name === 'backlog');
      expect(
        Number((backlog?.rows as Array<{ evaluated?: number }> | undefined)?.[0]?.evaluated),
      ).toBeGreaterThan(0);
      const backlogTemplate = (
        riskWeightedBacklogSql(where) as Prisma.Sql & { strings: readonly string[] }
      ).strings.join('');
      expect(backlogTemplate).toContain('coefficient');
      expect(backlogTemplate).not.toMatch(/SELECT count\(\*\)::int\s+FROM public.defect_items/);
    } finally {
      await owner.$executeRaw`
        DELETE FROM public.analytics_insight_defects link
        USING public.defect_items d, public.acts a
        WHERE link."defectItemId" = d.id
          AND d."actId" = a.id
          AND a."officialNumber" IN (${marker}, ${`${marker}-b`})
      `;
      await owner.$executeRaw`
        DELETE FROM public.analytics_insights insight
        WHERE insight."scopeFingerprint" = 'company'
          AND insight."generatedAt" > now() - interval '6 hours'
          AND NOT EXISTS (
            SELECT 1 FROM public.analytics_insight_defects link WHERE link."insightId" = insight.id
          )
      `;
      await owner.analyticsInsightDefect.deleteMany({
        where: { insight: { snapshotHash: `${marker}:perf` } },
      });
      await owner.analyticsInsight.deleteMany({ where: { snapshotHash: `${marker}:perf` } });
      await owner.$executeRaw`ALTER TABLE public.defect_financial_impacts DISABLE TRIGGER defect_financial_impacts_guard`;
      await owner.defectFinancialImpact.deleteMany({
        where: { defectItem: { act: { officialNumber: { in: [marker, `${marker}-b`] } } } },
      });
      await owner.$executeRaw`ALTER TABLE public.defect_financial_impacts ENABLE TRIGGER defect_financial_impacts_guard`;
      await owner.defectInspectionAttempt.deleteMany({
        where: { defectItem: { act: { officialNumber: { in: [marker, `${marker}-b`] } } } },
      });
      await owner.defectItemLiableOrganization.deleteMany({
        where: { defectItem: { act: { officialNumber: { in: [marker, `${marker}-b`] } } } },
      });
      await owner.defectItem.deleteMany({
        where: {
          act: { officialNumber: { in: [marker, `${marker}-b`] } },
          id: { not: defectId },
        },
      });
      await owner.act.deleteMany({ where: { officialNumber: `${marker}-b` } });
      await owner.workType
        .deleteMany({ where: { code: marker.slice(0, 20) } })
        .catch(() => undefined);
      await owner.defectType
        .deleteMany({ where: { code: `${marker}-b`.slice(0, 24).toUpperCase() } })
        .catch(() => undefined);
      await owner.propertyObject
        .deleteMany({ where: { name: `${marker} object 2` } })
        .catch(() => undefined);
      await owner.$executeRaw`ALTER TABLE public.defect_inspection_attempts ENABLE TRIGGER defect_inspection_attempts_guard`;
      await owner.$executeRaw`ALTER TABLE public.defect_items ENABLE TRIGGER trg_sgr_refresh_act_status_from_defects`;
    }
  }, 480_000);
});

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function executionMs(plan: unknown): number {
  const match = /"Execution Time":\s*([0-9.]+)/.exec(JSON.stringify(plan ?? ''));
  return match ? Number(match[1]) : 0;
}
