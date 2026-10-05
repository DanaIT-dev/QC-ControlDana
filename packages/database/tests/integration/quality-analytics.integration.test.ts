import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIRMED_LAST_FIRST_TOKEN_ORDER, personNameWriteFields } from '@sgr-registry/domain';
import {
  createOwnerPrismaClient,
  createPrismaClient,
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
    const superAdmin = await owner.user.findFirst({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
      select: { id: true },
    });
    if (!superAdmin) {
      throw new Error('active super admin is required');
    }
    superAdminId = superAdmin.id;
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

  it('uses the created-at index for a large defect population', async () => {
    await owner.$executeRaw`ALTER TABLE public.defect_items DISABLE TRIGGER trg_sgr_refresh_act_status_from_defects`;
    try {
      await owner.$executeRaw`
        INSERT INTO public.defect_items (id, "actId", "defectTypeId", status, location, "claimDetails", "createdAt", "updatedAt")
        SELECT gen_random_uuid(), ${actId}::uuid, ${defectTypeId}::uuid, 'IN_PROGRESS'::"DefectItemStatus", 'Синтетика', 'Синтетика', now(), now()
        FROM generate_series(1, 100000)
      `;
      await owner.$executeRaw`ANALYZE public.defect_items`;
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
    } finally {
      await owner.defectItem.deleteMany({ where: { actId, id: { not: defectId } } });
      await owner.$executeRaw`ALTER TABLE public.defect_items ENABLE TRIGGER trg_sgr_refresh_act_status_from_defects`;
    }
  }, 120_000);
});
