import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  calendarDateToUtcNoon,
  CONFIRMED_LAST_FIRST_TOKEN_ORDER,
  personNameWriteFields,
} from '@sgr-registry/domain';
import {
  createOwnerPrismaClient,
  createPrismaClient,
  postgresUrlWithoutSchema,
  updatePropertyObjectViaDefiner,
  withAuthenticatedDbContext,
} from '../../src/index';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';

const appUrl = process.env.DATABASE_URL ?? '';
const migratorUrl = process.env.MIGRATION_DATABASE_URL ?? '';
const secret = process.env.RLS_CONTEXT_SECRET ?? '';

assertSafeTestDatabaseUrl(appUrl);
assertSafeTestDatabaseUrl(migratorUrl);

const owner = createOwnerPrismaClient(migratorUrl);
const appPrisma = createPrismaClient(appUrl);
const MARKER = `objupd-${randomUUID().slice(0, 8)}`;

async function sql(
  url: string,
  query: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[]; rowCount: number; error?: string }> {
  const pool = new Pool({ connectionString: postgresUrlWithoutSchema(url), max: 1 });
  try {
    const result = await pool.query(query, params);
    return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
  } catch (error) {
    return {
      rows: [],
      rowCount: 0,
      error: error instanceof Error ? error.message : 'query failed',
    };
  } finally {
    await pool.end();
  }
}

describe('property object protected update', () => {
  let adminId = '';
  let engineerId = '';
  let objectId = '';

  beforeAll(async () => {
    const admin = await owner.user.create({
      data: {
        ...personNameWriteFields(`${MARKER} admin`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
        email: `${MARKER}.admin@example.sgr.local`,
        role: 'ADMIN',
        sessionVersion: 1,
      },
    });
    const engineer = await owner.user.create({
      data: {
        ...personNameWriteFields(`${MARKER} engineer`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
        email: `${MARKER}.engineer@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
        sessionVersion: 1,
      },
    });
    adminId = admin.id;
    engineerId = engineer.id;
    const object = await owner.propertyObject.create({
      data: {
        name: `${MARKER} object`,
        address: `${MARKER} address`,
        sourceSystem: 'excel',
        sourceRow: 42,
        sourceImportKey: `${MARKER}-key`,
        sourceResponsibleEngineerName: 'Василевич М.В.',
      },
    });
    objectId = object.id;
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe(
      'ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only',
    );
    try {
      await owner.auditLog.deleteMany({
        where: {
          OR: [{ entityId: objectId }, { actorUserId: { in: [adminId, engineerId] } }],
        },
      });
    } finally {
      await owner.$executeRawUnsafe(
        'ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only',
      );
    }
    await owner.propertyObject.deleteMany({ where: { id: objectId } });
    await owner.user.deleteMany({ where: { id: { in: [adminId, engineerId] } } });
    await owner.$disconnect();
    await appPrisma.$disconnect();
  });

  it('rejects unrestricted UPDATE/DELETE from sgr_app and preserves import metadata', async () => {
    const direct = await sql(appUrl, `UPDATE public.property_objects SET name = $1 WHERE id = $2`, [
      `${MARKER} forged`,
      objectId,
    ]);
    expect(direct.error ?? '').toMatch(/permission|42501|must be owner|row-level security|policy/i);
    const del = await sql(appUrl, `DELETE FROM public.property_objects WHERE id = $1`, [objectId]);
    expect(del.error ?? '').toBe('');
    expect(del.rowCount).toBe(0);
    expect(await owner.propertyObject.findUnique({ where: { id: objectId } })).not.toBeNull();

    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: engineerId, sessionVersion: 1 },
        callback: (tx) =>
          updatePropertyObjectViaDefiner(tx, {
            id: objectId,
            expectedVersion: 1,
            name: `${MARKER} engineer`,
            address: `${MARKER} address`,
            active: true,
            actorUserId: engineerId,
            actorName: `${MARKER} engineer`,
            requestId: `${MARKER}-eng`,
          }),
      }),
    ).rejects.toThrow();

    const updated = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: (tx) =>
        updatePropertyObjectViaDefiner(tx, {
          id: objectId,
          expectedVersion: 1,
          name: `${MARKER} renamed`,
          address: `${MARKER} new-address`,
          active: false,
          actorUserId: adminId,
          actorName: `${MARKER} admin`,
          requestId: `${MARKER}-adm`,
        }),
    });
    expect(updated.name).toBe(`${MARKER} renamed`);
    expect(updated.address).toBe(`${MARKER} new-address`);
    expect(updated.active).toBe(false);
    expect(updated.sourceSystem).toBe('excel');
    expect(updated.sourceRow).toBe(42);
    expect(updated.sourceImportKey).toBe(`${MARKER}-key`);
    expect(updated.sourceResponsibleEngineerName).toBe('Василевич М.В.');
    const audits = await owner.auditLog.findMany({
      where: {
        entityId: objectId,
        action: { in: ['PROPERTY_OBJECT_UPDATED', 'PROPERTY_OBJECT_STATUS_CHANGED'] },
      },
    });
    expect(audits.some((row) => row.action === 'PROPERTY_OBJECT_UPDATED')).toBe(true);
    expect(audits.some((row) => row.action === 'PROPERTY_OBJECT_STATUS_CHANGED')).toBe(true);
  });

  it('updates calendar dates atomically and keeps an unchanged historical mismatch', async () => {
    const dated = await owner.propertyObject.create({
      data: {
        name: `${MARKER} dates`,
        address: `${MARKER} dates-address`,
        sourceSystem: 'excel',
        sourceRow: 7,
        sourceImportKey: `${MARKER}-dates`,
        commissionedAt: calendarDateToUtcNoon('2024-01-15'),
        warrantyEndsAt: calendarDateToUtcNoon('2029-01-15'),
      },
    });
    const mismatched = await owner.propertyObject.create({
      data: {
        name: `${MARKER} mismatch`,
        address: `${MARKER} mismatch-address`,
        commissionedAt: calendarDateToUtcNoon('2024-06-02'),
        warrantyEndsAt: calendarDateToUtcNoon('2024-06-01'),
      },
    });
    try {
      const both = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: adminId, sessionVersion: 1 },
        callback: (tx) =>
          updatePropertyObjectViaDefiner(tx, {
            id: dated.id,
            expectedVersion: 1,
            name: dated.name,
            address: dated.address,
            active: true,
            setCommissionedAt: true,
            commissionedAt: calendarDateToUtcNoon('2024-02-01'),
            setWarrantyEndsAt: true,
            warrantyEndsAt: calendarDateToUtcNoon('2029-02-01'),
            actorUserId: adminId,
            actorName: `${MARKER} admin`,
            requestId: `${MARKER}-dates`,
          }),
      });
      expect(both.commissionedAt?.toISOString()).toBe('2024-02-01T12:00:00.000Z');
      expect(both.warrantyEndsAt?.toISOString()).toBe('2029-02-01T12:00:00.000Z');
      expect(both.sourceImportKey).toBe(`${MARKER}-dates`);
      const audit = await owner.auditLog.findFirst({
        where: { entityId: dated.id, action: 'PROPERTY_OBJECT_UPDATED' },
        orderBy: { occurredAt: 'desc' },
      });
      expect(audit?.actorUserId).toBe(adminId);
      expect(audit?.occurredAt).toBeInstanceOf(Date);
      expect(audit?.oldValue).toMatchObject({
        commissionedAt: '2024-01-15',
        warrantyEndsAt: '2029-01-15',
      });
      expect(audit?.newValue).toMatchObject({
        commissionedAt: '2024-02-01',
        warrantyEndsAt: '2029-02-01',
      });

      const cleared = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: adminId, sessionVersion: 1 },
        callback: (tx) =>
          updatePropertyObjectViaDefiner(tx, {
            id: dated.id,
            expectedVersion: both.version,
            name: dated.name,
            address: dated.address,
            active: true,
            setCommissionedAt: true,
            commissionedAt: null,
            actorUserId: adminId,
            actorName: `${MARKER} admin`,
            requestId: `${MARKER}-clear`,
          }),
      });
      expect(cleared.commissionedAt).toBeNull();
      expect(cleared.warrantyEndsAt?.toISOString()).toBe('2029-02-01T12:00:00.000Z');

      await expect(
        withAuthenticatedDbContext({
          prisma: appPrisma,
          secret,
          user: { id: adminId, sessionVersion: 1 },
          callback: (tx) =>
            updatePropertyObjectViaDefiner(tx, {
              id: dated.id,
              expectedVersion: 1,
              name: `${MARKER} stale-dates`,
              address: dated.address,
              active: true,
              setWarrantyEndsAt: true,
              warrantyEndsAt: calendarDateToUtcNoon('2020-01-01'),
              actorUserId: adminId,
              actorName: `${MARKER} admin`,
              requestId: `${MARKER}-stale`,
            }),
        }),
      ).rejects.toThrow(/изменена другим|40001/);
      const afterStale = await owner.propertyObject.findUniqueOrThrow({ where: { id: dated.id } });
      expect(afterStale.warrantyEndsAt?.toISOString()).toBe('2029-02-01T12:00:00.000Z');
      expect(afterStale.name).toBe(dated.name);

      await expect(
        withAuthenticatedDbContext({
          prisma: appPrisma,
          secret,
          user: { id: adminId, sessionVersion: 1 },
          callback: (tx) =>
            updatePropertyObjectViaDefiner(tx, {
              id: mismatched.id,
              expectedVersion: 1,
              name: mismatched.name,
              address: mismatched.address,
              active: true,
              setCommissionedAt: true,
              commissionedAt: calendarDateToUtcNoon('2024-08-01'),
              actorUserId: adminId,
              actorName: `${MARKER} admin`,
              requestId: `${MARKER}-inverted`,
            }),
        }),
      ).rejects.toThrow(/гарантии/);
      const mismatchUntouched = await owner.propertyObject.findUniqueOrThrow({
        where: { id: mismatched.id },
      });
      expect(mismatchUntouched.version).toBe(1);
      expect(mismatchUntouched.commissionedAt?.toISOString()).toBe('2024-06-02T12:00:00.000Z');

      const renamedMismatch = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: adminId, sessionVersion: 1 },
        callback: (tx) =>
          updatePropertyObjectViaDefiner(tx, {
            id: mismatched.id,
            expectedVersion: 1,
            name: `${MARKER} mismatch renamed`,
            address: mismatched.address,
            active: true,
            actorUserId: adminId,
            actorName: `${MARKER} admin`,
            requestId: `${MARKER}-keep`,
          }),
      });
      expect(renamedMismatch.name).toBe(`${MARKER} mismatch renamed`);
      expect(renamedMismatch.commissionedAt?.toISOString()).toBe('2024-06-02T12:00:00.000Z');
      expect(renamedMismatch.warrantyEndsAt?.toISOString()).toBe('2024-06-01T12:00:00.000Z');
    } finally {
      await owner.$executeRawUnsafe(
        'ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only',
      );
      try {
        await owner.auditLog.deleteMany({
          where: { entityId: { in: [dated.id, mismatched.id] } },
        });
      } finally {
        await owner.$executeRawUnsafe(
          'ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only',
        );
      }
      await owner.propertyObject.deleteMany({ where: { id: { in: [dated.id, mismatched.id] } } });
    }
  });
});
