import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { CONFIRMED_LAST_FIRST_TOKEN_ORDER, personNameWriteFields } from '@sgr-registry/domain';
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
});
