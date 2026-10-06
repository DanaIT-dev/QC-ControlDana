import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { CONFIRMED_LAST_FIRST_TOKEN_ORDER, personNameWriteFields } from '@sgr-registry/domain';
import { Prisma } from '@prisma/client';
import {
  createOwnerPrismaClient,
  invalidTemporalCountSql,
  overviewClosureSql,
} from '../../src/index';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';

const migratorUrl = process.env.MIGRATION_DATABASE_URL ?? '';
assertSafeTestDatabaseUrl(migratorUrl);
const owner = createOwnerPrismaClient(migratorUrl);
const marker = `temporal-${randomUUID().slice(0, 8)}`;

describe('temporal event order', () => {
  const createdIds: string[] = [];
  let actId = '';
  let userId = '';

  afterAll(async () => {
    if (actId) {
      await owner.defectInspectionAttempt
        .deleteMany({ where: { defectItem: { actId } } })
        .catch(() => undefined);
      await owner.defectItem.deleteMany({ where: { actId } }).catch(() => undefined);
      await owner.act.deleteMany({ where: { id: actId } }).catch(() => undefined);
    }
    if (userId) {
      await owner.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    }
    await owner.defectType
      .deleteMany({ where: { code: marker.toUpperCase() } })
      .catch(() => undefined);
    await owner.organization
      .deleteMany({ where: { email: `${marker}@example.sgr.local` } })
      .catch(() => undefined);
    await owner.propertyObject.deleteMany({ where: { name: marker } }).catch(() => undefined);
    await owner.$disconnect();
  });

  it('keeps valid durations and excludes a legacy reversed pair from the median', async () => {
    const user = await owner.user.create({
      data: {
        ...personNameWriteFields(`Порядок ${marker}`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
        email: `${marker}@example.sgr.local`,
        role: 'ADMIN',
      },
    });
    userId = user.id;
    const object = await owner.propertyObject.create({
      data: { name: marker, address: 'Минск' },
    });
    const customer = await owner.organization.create({
      data: {
        officialName: marker,
        postalAddress: 'addr',
        email: `${marker}@example.sgr.local`,
        phone: '1',
        contactPerson: 'П',
      },
    });
    const defectType = await owner.defectType.create({
      data: { code: marker.toUpperCase(), name: marker, sortOrder: 910 },
    });
    const createdAt = new Date('2026-05-01T00:00:00.000Z');
    const act = await owner.act.create({
      data: {
        formCode: 'S1',
        year: 2096,
        sequence: Math.floor(Math.random() * 800_000) + 100_000,
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: createdAt,
        createdAt,
        status: 'IN_PROGRESS',
        startedAt: createdAt,
        officialNumber: marker,
      },
    });
    actId = act.id;
    const valid = await owner.defectItem.create({
      data: {
        actId,
        defectTypeId: defectType.id,
        status: 'COMPLETED',
        location: 'valid',
        claimDetails: 'valid',
        createdAt,
        readyAt: new Date('2026-05-04T00:00:00.000Z'),
      },
    });
    createdIds.push(valid.id);
    await expect(
      owner.defectItem.create({
        data: {
          actId,
          defectTypeId: defectType.id,
          status: 'COMPLETED',
          location: 'rejected',
          claimDetails: 'rejected',
          createdAt,
          readyAt: new Date('2026-04-01T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();
    await expect(
      owner.defectInspectionAttempt.create({
        data: {
          defectItemId: valid.id,
          attemptNumber: 1,
          status: 'ACCEPTED',
          submittedByUserId: userId,
          submittedAt: new Date('2026-05-03T00:00:00.000Z'),
          reviewedByUserId: userId,
          reviewedAt: new Date('2026-05-02T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();

    await owner.$executeRaw`ALTER TABLE public.defect_items DROP CONSTRAINT IF EXISTS defect_items_ready_not_before_created`;
    const invalid = await owner.defectItem.create({
      data: {
        actId,
        defectTypeId: defectType.id,
        status: 'COMPLETED',
        location: 'legacy-invalid',
        claimDetails: 'legacy-invalid',
        createdAt,
        readyAt: new Date('2026-04-01T00:00:00.000Z'),
      },
    });
    createdIds.push(invalid.id);
    await owner.$executeRaw`
      ALTER TABLE public.defect_items
      ADD CONSTRAINT defect_items_ready_not_before_created
      CHECK ("readyAt" IS NULL OR "readyAt" >= "createdAt") NOT VALID
    `;

    const where = Prisma.sql`d."actId" = ${actId}::uuid`;
    const closure = await owner.$queryRaw<Array<{ median: number | null; sample: number }>>(
      overviewClosureSql(where),
    );
    const invalidCount = await owner.$queryRaw<Array<{ n: number }>>(
      invalidTemporalCountSql(where),
    );
    expect(closure[0]?.sample).toBe(1);
    expect(Number(closure[0]?.median)).toBeGreaterThan(0);
    expect(invalidCount[0]?.n).toBe(1);
  });

  it('does not let a concurrent update reverse an attempt', async () => {
    const createdAt = new Date('2026-05-01T00:00:00.000Z');
    const defect = await owner.defectItem.create({
      data: {
        actId,
        defectTypeId: (
          await owner.defectType.findUniqueOrThrow({ where: { code: marker.toUpperCase() } })
        ).id,
        status: 'PENDING_INSPECTION',
        location: 'concurrent',
        claimDetails: 'concurrent',
        createdAt,
        submittedForInspectionAt: new Date('2026-05-02T00:00:00.000Z'),
      },
    });
    const submittedAt = new Date('2026-05-02T00:00:00.000Z');
    const reviewedAt = new Date('2026-05-03T00:00:00.000Z');
    const attempt = await owner.defectInspectionAttempt.create({
      data: {
        defectItemId: defect.id,
        attemptNumber: 1,
        status: 'PENDING',
        submittedByUserId: userId,
        submittedAt,
      },
    });
    const other = createOwnerPrismaClient(migratorUrl);
    const later = new Date('2026-05-04T00:00:00.000Z');
    const results = await Promise.allSettled([
      owner.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM public.defect_inspection_attempts WHERE id = ${attempt.id}::uuid FOR UPDATE`;
        await new Promise((resolve) => setTimeout(resolve, 150));
        await tx.defectInspectionAttempt.update({
          where: { id: attempt.id },
          data: { reviewedAt, status: 'ACCEPTED' },
        });
      }),
      other.$transaction(async (tx) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        await tx.defectInspectionAttempt.update({
          where: { id: attempt.id },
          data: { submittedAt: later },
        });
      }),
    ]);
    await other.$disconnect();
    expect(results.some((result) => result.status === 'rejected')).toBe(true);
    const stored = await owner.defectInspectionAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    if (stored.reviewedAt) {
      expect(stored.reviewedAt.getTime()).toBeGreaterThanOrEqual(stored.submittedAt.getTime());
    }
  });
});
