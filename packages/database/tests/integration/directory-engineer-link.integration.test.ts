import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { CONFIRMED_LAST_FIRST_TOKEN_ORDER, personNameWriteFields } from '@sgr-registry/domain';
import {
  createOwnerPrismaClient,
  createPrismaClient,
  postgresUrlWithoutSchema,
  reconcileDirectoryEngineerLinks,
  revokeEngineerObjectAccess,
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
const MARKER = `dirlink-${randomUUID().slice(0, 8)}`;
const SURNAME = `Дирсвязка${MARKER.replace(/[^a-z0-9]/gi, '').slice(0, 6)}`;
const SOURCE_NAME = `${SURNAME} А.А.`;
const ACCOUNT_NAME = `${SURNAME} Антон Антонович`;
const SIMILAR_NAME = `${SURNAME}я Антон Антонович`;
const TWIN_NAME = `${SURNAME} Андрей Андреевич`;
const FOREIGN_SOURCE = `Чужой${SURNAME} И.И.`;

async function sql(
  url: string,
  query: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const pool = new Pool({ connectionString: postgresUrlWithoutSchema(url), max: 1 });
  try {
    const result = await pool.query(query, params);
    return { rows: result.rows as Record<string, unknown>[] };
  } catch (error) {
    return { rows: [], error: error instanceof Error ? error.message : 'query failed' };
  } finally {
    await pool.end();
  }
}

describe('directory engineer linking', () => {
  const objectIds: string[] = [];
  const userIds: string[] = [];
  let adminId = '';
  let engineerId = '';
  let similarId = '';
  let contractorId = '';
  let objectAId = '';
  let objectBId = '';
  let foreignId = '';

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
        ...personNameWriteFields(ACCOUNT_NAME, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
        email: `${MARKER}.vasilevich@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
        sessionVersion: 1,
      },
    });
    const similar = await owner.user.create({
      data: {
        ...personNameWriteFields(SIMILAR_NAME, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
        email: `${MARKER}.similar@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
        sessionVersion: 1,
      },
    });
    const contractor = await owner.user.create({
      data: {
        ...personNameWriteFields(ACCOUNT_NAME, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
        email: `${MARKER}.contractor@example.sgr.local`,
        role: 'CONTRACTOR_ENGINEER',
        sessionVersion: 1,
      },
    });
    adminId = admin.id;
    engineerId = engineer.id;
    similarId = similar.id;
    contractorId = contractor.id;
    userIds.push(admin.id, engineer.id, similar.id, contractor.id);

    const objectA = await owner.propertyObject.create({
      data: {
        name: `${MARKER} дом А`,
        address: `${MARKER} адрес А`,
        sourceResponsibleEngineerName: SOURCE_NAME,
      },
    });
    const objectB = await owner.propertyObject.create({
      data: {
        name: `${MARKER} дом Б`,
        address: `${MARKER} адрес Б`,
        sourceResponsibleEngineerName: SOURCE_NAME,
      },
    });
    const foreign = await owner.propertyObject.create({
      data: {
        name: `${MARKER} чужой`,
        address: `${MARKER} чужой адрес`,
        sourceResponsibleEngineerName: FOREIGN_SOURCE,
      },
    });
    objectAId = objectA.id;
    objectBId = objectB.id;
    foreignId = foreign.id;
    objectIds.push(objectA.id, objectB.id, foreign.id);
  });

  afterAll(async () => {
    await owner.propertyObjectEngineer.deleteMany({
      where: { OR: [{ propertyObjectId: { in: objectIds } }, { userId: { in: userIds } }] },
    });
    await owner.$executeRawUnsafe(
      'ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only',
    );
    try {
      await owner.auditLog.deleteMany({
        where: {
          OR: [{ actorUserId: { in: userIds } }, { entityId: { in: objectIds } }],
        },
      });
    } finally {
      await owner.$executeRawUnsafe(
        'ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only',
      );
    }
    await owner.propertyObject.deleteMany({ where: { id: { in: objectIds } } });
    await owner.user.deleteMany({ where: { id: { in: userIds } } });
    await owner.$disconnect();
    await appPrisma.$disconnect();
  });

  it('links every object of a uniquely matching engineer and stays idempotent', async () => {
    const first = await reconcileDirectoryEngineerLinks(owner, {
      actorUserId: adminId,
      actorName: `${MARKER} admin`,
      requestId: `${MARKER}-1`,
      source: 'SYSTEM',
    });
    expect(first.linked).toBeGreaterThanOrEqual(2);
    const links = await owner.propertyObjectEngineer.findMany({
      where: {
        propertyObjectId: { in: [objectAId, objectBId] },
        directoryLinkMethod: 'AUTO_EXACT',
        unassignedAt: null,
      },
    });
    expect(links).toHaveLength(2);
    expect(links.every((row) => row.userId === engineerId)).toBe(true);
    expect(
      await owner.propertyObjectEngineer.count({
        where: { propertyObjectId: foreignId, unassignedAt: null },
      }),
    ).toBe(0);

    const auditsBefore = await owner.auditLog.count({
      where: { action: { startsWith: 'PROPERTY_OBJECT_ENGINEER_' } },
    });
    const second = await reconcileDirectoryEngineerLinks(owner, {
      actorUserId: adminId,
      actorName: `${MARKER} admin`,
      requestId: `${MARKER}-2`,
      source: 'SYSTEM',
    });
    expect(second.linked).toBe(0);
    expect(
      await owner.propertyObjectEngineer.count({
        where: {
          propertyObjectId: { in: [objectAId, objectBId] },
          directoryLinkMethod: 'AUTO_EXACT',
        },
      }),
    ).toBe(2);
    expect(
      await owner.auditLog.count({
        where: { action: { startsWith: 'PROPERTY_OBJECT_ENGINEER_' } },
      }),
    ).toBe(auditsBefore);
  });

  it('does not auto-link when two active engineers match the same source name', async () => {
    const twin = await owner.user.create({
      data: {
        ...personNameWriteFields(TWIN_NAME, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
        email: `${MARKER}.twin@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
        sessionVersion: 1,
      },
    });
    userIds.push(twin.id);
    const result = await reconcileDirectoryEngineerLinks(owner, {
      actorUserId: adminId,
      actorName: `${MARKER} admin`,
      requestId: `${MARKER}-amb`,
      source: 'SYSTEM',
    });
    expect(result.unlinked).toBeGreaterThanOrEqual(2);
    expect(
      await owner.propertyObjectEngineer.count({
        where: {
          propertyObjectId: { in: [objectAId, objectBId] },
          directoryLinkMethod: { not: null },
          unassignedAt: null,
        },
      }),
    ).toBe(0);
    await owner.user.update({
      where: { id: twin.id },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    await reconcileDirectoryEngineerLinks(owner, {
      actorUserId: adminId,
      actorName: `${MARKER} admin`,
      requestId: `${MARKER}-amb-restore`,
      source: 'SYSTEM',
    });
  });

  it('revokes access when the engineer is archived or loses the role', async () => {
    await reconcileDirectoryEngineerLinks(owner, {
      actorUserId: adminId,
      actorName: `${MARKER} admin`,
      requestId: `${MARKER}-before-archive`,
      source: 'SYSTEM',
    });
    await owner.user.update({
      where: { id: engineerId },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    await revokeEngineerObjectAccess(owner, {
      userId: engineerId,
      actorUserId: adminId,
      actorName: `${MARKER} admin`,
      requestId: `${MARKER}-archive`,
      source: 'SYSTEM',
    });
    expect(
      await owner.propertyObjectEngineer.count({
        where: { userId: engineerId, unassignedAt: null },
      }),
    ).toBe(0);
    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: engineerId, sessionVersion: 1 },
        callback: (tx) => tx.propertyObject.findMany({ where: { id: objectAId } }),
      }),
    ).rejects.toThrow(/RLS context rejected/);
    expect(
      await owner.propertyObject.findUniqueOrThrow({
        where: { id: objectAId },
        select: { sourceResponsibleEngineerName: true },
      }),
    ).toEqual({ sourceResponsibleEngineerName: SOURCE_NAME });

    await owner.user.update({
      where: { id: engineerId },
      data: { status: 'ACTIVE', archivedAt: null, role: 'SGR_MANAGER' },
    });
    await revokeEngineerObjectAccess(owner, {
      userId: engineerId,
      actorUserId: adminId,
      actorName: `${MARKER} admin`,
      requestId: `${MARKER}-role`,
      source: 'SYSTEM',
    });
    await owner.user.update({
      where: { id: engineerId },
      data: { role: 'RESPONSIBLE_ENGINEER' },
    });
    const withoutRoleAccess = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: engineerId, sessionVersion: 1 },
      callback: (tx) => tx.propertyObject.findMany({ where: { id: objectAId } }),
    });
    expect(withoutRoleAccess).toHaveLength(0);
    await reconcileDirectoryEngineerLinks(owner, {
      actorUserId: adminId,
      actorName: `${MARKER} admin`,
      requestId: `${MARKER}-role-back`,
      source: 'SYSTEM',
    });
    const restored = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: engineerId, sessionVersion: 1 },
      callback: (tx) =>
        tx.propertyObject.findMany({ where: { id: { in: [objectAId, foreignId] } } }),
    });
    expect(restored.map((row) => row.id)).toEqual([objectAId]);
  });

  it('lets RLS show only assigned objects and rejects direct SQL and forged context', async () => {
    await reconcileDirectoryEngineerLinks(owner, {
      actorUserId: adminId,
      actorName: `${MARKER} admin`,
      requestId: `${MARKER}-rls`,
      source: 'SYSTEM',
    });
    const scoped = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: engineerId, sessionVersion: 1 },
      callback: async (tx) => ({
        mine: await tx.propertyObject.findMany({ where: { id: { in: [objectAId, objectBId] } } }),
        foreign: await tx.propertyObject.findMany({ where: { id: foreignId } }),
        similar: await tx.propertyObject.findMany({
          where: { id: objectAId },
        }),
      }),
    });
    expect(scoped.mine).toHaveLength(2);
    expect(scoped.foreign).toHaveLength(0);

    const similarView = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: similarId, sessionVersion: 1 },
      callback: (tx) => tx.propertyObject.findMany({ where: { id: objectAId } }),
    });
    expect(similarView).toHaveLength(0);

    const contractorView = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: contractorId, sessionVersion: 1 },
      callback: (tx) =>
        tx.propertyObjectEngineer.findMany({
          where: { propertyObjectId: objectAId, userId: contractorId, unassignedAt: null },
        }),
    });
    expect(contractorView).toHaveLength(0);

    const noContext = await sql(
      appUrl,
      `INSERT INTO property_object_engineers (id, "propertyObjectId", "userId", "directoryLinkMethod")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'AUTO_EXACT')`,
      [randomUUID(), foreignId, engineerId],
    );
    expect(noContext.error).toMatch(/42501|Недостаточно прав|RLS|policy/i);

    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: adminId, sessionVersion: 1 },
        callback: (tx) =>
          tx.propertyObjectEngineer.create({
            data: {
              propertyObjectId: foreignId,
              userId: engineerId,
              directoryLinkMethod: 'AUTO_EXACT',
            },
          }),
      }),
    ).rejects.toThrow(/Недостаточно прав|42501/);

    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: engineerId, sessionVersion: 1 },
        callback: async (tx) => {
          await tx.$executeRaw`SELECT set_config('sgr.uid', ${adminId}, true)`;
          await tx.$executeRaw`SELECT set_config('sgr.role', 'ADMIN', true)`;
          return tx.$queryRaw`
            SELECT changed FROM public.sgr_apply_directory_engineer_link(
              ${foreignId}::uuid,
              ${engineerId}::uuid,
              'ADMIN_CONFIRMED',
              'MATCHED',
              ${engineerId}::uuid,
              'forged',
              ${`${MARKER}-forged`},
              'WEB'::public."AuditSource"
            )
          `;
        },
      }),
    ).rejects.toThrow(/Недостаточно прав|42501/);
  });
});
