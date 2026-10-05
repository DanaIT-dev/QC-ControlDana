import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIRMED_LAST_FIRST_TOKEN_ORDER, personNameWriteFields } from '@sgr-registry/domain';
import {
  createOwnerPrismaClient,
  createPrismaClient,
  signUserRlsContext,
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
          scopeFingerprint: `perf:${marker}`,
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
      await owner.$executeRaw`ANALYZE public.defect_items`;
      await owner.$executeRaw`ANALYZE public.defect_inspection_attempts`;
      await owner.$executeRaw`ANALYZE public.defect_financial_impacts`;
      await owner.$executeRaw`ANALYZE public.analytics_insight_defects`;
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
      const measured = await app.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT sgr_set_request_context(${token})`;
          const topStarted = Date.now();
          const top = await tx.$queryRaw<Array<{ id: string }>>`
            WITH population AS MATERIALIZED (
              SELECT d.id, d."defectTypeId", d.status::text AS status, d."createdAt", d."effectiveDeadline"
              FROM public.defect_items d
              JOIN public.acts a ON a.id = d."actId"
              WHERE d."actId" = ${actId}::uuid
            ),
            type_counts AS (
              SELECT "defectTypeId", count(*)::int AS type_count FROM population GROUP BY "defectTypeId"
            ),
            open_defects AS (
              SELECT id, "createdAt", "effectiveDeadline", "defectTypeId"
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
            ),
            ranked AS (
              SELECT open_defects.id::text AS id,
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
            )
            SELECT id FROM ranked ORDER BY score DESC, id ASC LIMIT 10
          `;
          const topMs = Date.now() - topStarted;
          const exposureStarted = Date.now();
          await tx.$queryRaw`
            SELECT sum(impact."amountByn") FILTER (
              WHERE impact.status::text = 'CONFIRMED'
                AND impact."amountType"::text = 'ACTUAL_COST'
                AND impact."payerType"::text = 'COMPANY'
            )::text
            FROM public.defect_items d
            JOIN public.acts a ON a.id = d."actId"
            JOIN public.defect_financial_impacts impact ON impact."defectItemId" = d.id
            WHERE d."actId" = ${actId}::uuid
          `;
          const exposureMs = Date.now() - exposureStarted;
          const backlogStarted = Date.now();
          await tx.$queryRaw`
            SELECT count(*)::int
            FROM public.defect_items d
            JOIN public.acts a ON a.id = d."actId"
            WHERE d."actId" = ${actId}::uuid
              AND d.status::text IN ('IN_PROGRESS', 'PENDING_INSPECTION')
          `;
          const backlogMs = Date.now() - backlogStarted;
          const supportStarted = Date.now();
          const supportCount = await tx.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n
            FROM public.analytics_insight_defects link
            JOIN public.defect_items d ON d.id = link."defectItemId"
            WHERE link."insightId" = ${insight.id}::uuid
          `;
          const supportMs = Date.now() - supportStarted;
          const plan = await tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
            EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
            SELECT d.id
            FROM public.defect_items d
            JOIN public.acts a ON a.id = d."actId"
            WHERE d."actId" = ${actId}::uuid AND d.status::text <> 'COMPLETED'
            ORDER BY d."createdAt" DESC
            LIMIT 10
          `;
          return { top, topMs, exposureMs, backlogMs, supportCount, supportMs, plan };
        },
        { maxWait: 10_000, timeout: 90_000 },
      );
      process.stderr.write(
        `analytics top-risks ${measured.topMs} ms; exposure ${measured.exposureMs} ms; backlog ${measured.backlogMs} ms; support-drilldown ${measured.supportMs} ms\n${measured.plan.map((row) => row['QUERY PLAN']).join('\n')}\n`,
      );
      expect(measured.topMs).toBeLessThan(8000);
      expect(measured.top[0]?.id).toBe(riskyId);
      expect(measured.supportCount[0]?.n).toBe(1000);
    } finally {
      await owner.analyticsInsightDefect.deleteMany({
        where: { defectItem: { actId } },
      });
      await owner.analyticsInsight.deleteMany({ where: { snapshotHash: `${marker}:perf` } });
      await owner.$executeRaw`ALTER TABLE public.defect_financial_impacts DISABLE TRIGGER defect_financial_impacts_guard`;
      await owner.defectFinancialImpact.deleteMany({ where: { defectItem: { actId } } });
      await owner.$executeRaw`ALTER TABLE public.defect_financial_impacts ENABLE TRIGGER defect_financial_impacts_guard`;
      await owner.defectItem.deleteMany({ where: { actId, id: { not: defectId } } });
      await owner.$executeRaw`ALTER TABLE public.defect_items ENABLE TRIGGER trg_sgr_refresh_act_status_from_defects`;
    }
  }, 180_000);
});
