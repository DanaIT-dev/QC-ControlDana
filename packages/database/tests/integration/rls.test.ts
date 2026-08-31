import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  createOwnerPrismaClient,
  createPrismaClient,
  postgresUrlWithoutSchema,
  signUserRlsContext,
  withAuthenticatedDbContext,
  withWorkerDbContext,
} from '../../src/index';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';

const appUrl = process.env.DATABASE_URL ?? '';
const authUrl = process.env.AUTH_DATABASE_URL ?? '';
const workerUrl = process.env.WORKER_DATABASE_URL ?? '';
const migratorUrl = process.env.MIGRATION_DATABASE_URL ?? '';
const secret = process.env.RLS_CONTEXT_SECRET ?? '';

assertSafeTestDatabaseUrl(appUrl);
assertSafeTestDatabaseUrl(authUrl);
assertSafeTestDatabaseUrl(workerUrl);
assertSafeTestDatabaseUrl(migratorUrl);

const owner = createOwnerPrismaClient(migratorUrl);
const appPrisma = createPrismaClient(appUrl);

const MARKER = `rls-${randomUUID().slice(0, 8)}`;

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

describe('PostgreSQL RLS', () => {
  let adminId = '';
  let managerId = '';
  let responsibleId = '';
  let otherResponsibleId = '';
  let contractorId = '';
  let objectId = '';
  let otherObjectId = '';
  let actId = '';
  let otherActId = '';
  let defectId = '';
  let otherDefectId = '';
  let proposalAId = '';
  let proposalBId = '';
  let assignmentId = '';

  beforeAll(async () => {
    expect(secret.length).toBeGreaterThanOrEqual(32);
    const admin = await owner.user.create({
      data: {
        fullName: `${MARKER} admin`,
        email: `${MARKER}.admin@example.sgr.local`,
        role: 'ADMIN',
        sessionVersion: 1,
      },
    });
    const manager = await owner.user.create({
      data: {
        fullName: `${MARKER} manager`,
        email: `${MARKER}.manager@example.sgr.local`,
        role: 'SGR_MANAGER',
        sessionVersion: 1,
      },
    });
    const responsible = await owner.user.create({
      data: {
        fullName: `${MARKER} responsible`,
        email: `${MARKER}.responsible@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
        sessionVersion: 1,
      },
    });
    const otherResponsible = await owner.user.create({
      data: {
        fullName: `${MARKER} other-responsible`,
        email: `${MARKER}.other@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
        sessionVersion: 1,
      },
    });
    const contractor = await owner.user.create({
      data: {
        fullName: `${MARKER} contractor`,
        email: `${MARKER}.contractor@example.sgr.local`,
        role: 'CONTRACTOR_ENGINEER',
        sessionVersion: 1,
      },
    });
    adminId = admin.id;
    managerId = manager.id;
    responsibleId = responsible.id;
    otherResponsibleId = otherResponsible.id;
    contractorId = contractor.id;

    const object = await owner.propertyObject.create({
      data: { name: `${MARKER} object`, address: `${MARKER} address` },
    });
    const otherObject = await owner.propertyObject.create({
      data: { name: `${MARKER} other-object`, address: `${MARKER} other-address` },
    });
    objectId = object.id;
    otherObjectId = otherObject.id;

    const assignment = await owner.propertyObjectEngineer.create({
      data: { propertyObjectId: objectId, userId: responsibleId, assignedByUserId: adminId },
    });
    assignmentId = assignment.id;

    const org = await owner.organization.create({
      data: {
        officialName: `${MARKER} org`,
        postalAddress: 'addr',
        email: `${MARKER}.org@example.sgr.local`,
        phone: '1',
        contactPerson: 'C',
      },
    });
    const seqBase = Math.floor(Math.random() * 800_000) + 100_000;
    const act = await owner.act.create({
      data: {
        officialNumber: `${MARKER}-1`,
        formCode: 'S1',
        year: 2099,
        sequence: seqBase,
        objectId,
        customerOrganizationId: org.id,
        issuedOn: new Date('2026-01-15T12:00:00.000Z'),
        status: 'IN_PROGRESS',
      },
    });
    const otherAct = await owner.act.create({
      data: {
        officialNumber: `${MARKER}-2`,
        formCode: 'S1',
        year: 2099,
        sequence: seqBase + 1,
        objectId: otherObjectId,
        customerOrganizationId: org.id,
        issuedOn: new Date('2026-01-16T12:00:00.000Z'),
        status: 'IN_PROGRESS',
      },
    });
    actId = act.id;
    otherActId = otherAct.id;
    const defectType = await owner.defectType.upsert({
      where: { code: 'RLS_TEST' },
      update: {},
      create: { code: 'RLS_TEST', name: 'RLS test type', sortOrder: 900, active: true },
    });
    const defect = await owner.defectItem.create({
      data: {
        actId,
        location: 'loc',
        claimDetails: 'claim',
        defectTypeId: defectType.id,
      },
    });
    const otherDefect = await owner.defectItem.create({
      data: {
        actId: otherActId,
        location: 'other',
        claimDetails: 'claim',
        defectTypeId: defectType.id,
      },
    });
    defectId = defect.id;
    otherDefectId = otherDefect.id;
    await owner.defectItemEngineer.create({
      data: { defectItemId: otherDefectId, userId: responsibleId },
    });
    const proposalA = await owner.proposal.create({
      data: {
        defectItemId: defectId,
        slot: 'A',
        alternativeContractorOrganizationId: org.id,
        amount: 10,
      },
    });
    const proposalB = await owner.proposal.create({
      data: {
        defectItemId: defectId,
        slot: 'B',
        alternativeContractorOrganizationId: org.id,
        amount: 20,
      },
    });
    proposalAId = proposalA.id;
    proposalBId = proposalB.id;
    await owner.auditLog.create({
      data: {
        action: 'ACT_CREATED',
        entityType: 'ACT',
        entityId: actId,
        source: 'SYSTEM',
      },
    });
  });

  afterAll(async () => {
    const ids = (...values: string[]) => values.filter((value) => value.length > 0);
    const proposalIds = ids(proposalAId, proposalBId);
    if (proposalIds.length > 0) {
      await owner.proposal.deleteMany({ where: { id: { in: proposalIds } } });
    }
    if (otherDefectId) {
      await owner.defectItemEngineer.deleteMany({ where: { defectItemId: otherDefectId } });
    }
    const defectIds = ids(defectId, otherDefectId);
    if (defectIds.length > 0) {
      await owner.defectItem.deleteMany({ where: { id: { in: defectIds } } });
    }
    const actIds = ids(actId, otherActId);
    if (actIds.length > 0) {
      await owner.act.deleteMany({ where: { id: { in: actIds } } });
    }
    if (assignmentId) {
      await owner.propertyObjectEngineer.deleteMany({ where: { id: assignmentId } });
    }
    const objectIds = ids(objectId, otherObjectId);
    if (objectIds.length > 0) {
      await owner.propertyObject.deleteMany({ where: { id: { in: objectIds } } });
    }
    await owner.organization.deleteMany({ where: { email: `${MARKER}.org@example.sgr.local` } });
    await owner.user.deleteMany({
      where: {
        email: {
          in: [
            `${MARKER}.admin@example.sgr.local`,
            `${MARKER}.manager@example.sgr.local`,
            `${MARKER}.responsible@example.sgr.local`,
            `${MARKER}.other@example.sgr.local`,
            `${MARKER}.contractor@example.sgr.local`,
          ],
        },
      },
    });
    await owner.$disconnect();
    await appPrisma.$disconnect();
  });

  it('returns no protected rows without verified context', async () => {
    const acts = await sql(appUrl, 'SELECT id FROM acts WHERE id = $1', [actId]);
    expect(acts.error).toBeUndefined();
    expect(acts.rows).toHaveLength(0);
    const inserted = await sql(appUrl, 'INSERT INTO acts SELECT * FROM acts WHERE id = $1', [
      actId,
    ]);
    expect(inserted.rows).toHaveLength(0);
  });

  it('rejects forged, altered, and expired context signatures', async () => {
    const forged = await sql(appUrl, `SELECT sgr_set_request_context($1)`, [
      'v1.user|not-a-token.00',
    ]);
    expect(forged.error).toMatch(/RLS context rejected|28000/);
    const valid = signUserRlsContext(
      { userId: responsibleId, sessionVersion: 1, nonce: randomUUID() },
      secret,
    );
    const altered = `${valid.slice(0, -2)}ff`;
    const alteredResult = await sql(appUrl, `SELECT sgr_set_request_context($1)`, [altered]);
    expect(alteredResult.error).toMatch(/RLS context rejected|28000/);
    const expired = signUserRlsContext(
      {
        userId: responsibleId,
        sessionVersion: 1,
        nonce: randomUUID(),
        issuedAtMs: Date.now() - 120_000,
      },
      secret,
    );
    const expiredResult = await sql(appUrl, `SELECT sgr_set_request_context($1)`, [expired]);
    expect(expiredResult.error).toMatch(/RLS context rejected|28000/);
  });

  it('does not trust a raw set_config of user id or role', async () => {
    const spoof = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: responsibleId, sessionVersion: 1 },
      callback: async (tx) => {
        await tx.$executeRaw`SELECT set_config('sgr.uid', ${otherResponsibleId}, true)`;
        await tx.$executeRaw`SELECT set_config('sgr.role', 'ADMIN', true)`;
        return tx.act.findMany({ where: { id: otherActId } });
      },
    });
    expect(spoof).toHaveLength(0);
  });

  it('lets a responsible engineer see assigned-object acts and hides foreign ids', async () => {
    const visible = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: responsibleId, sessionVersion: 1 },
      callback: async (tx) => ({
        mine: await tx.act.findMany({ where: { id: actId } }),
        foreign: await tx.act.findMany({ where: { id: otherActId } }),
        defects: await tx.defectItem.findMany({ where: { actId } }),
      }),
    });
    expect(visible.mine).toHaveLength(1);
    expect(visible.foreign).toHaveLength(0);
    expect(visible.defects).toHaveLength(1);
  });

  it('does not expand object scope through DefectItemEngineer', async () => {
    const rows = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: responsibleId, sessionVersion: 1 },
      callback: (tx) => tx.defectItem.findMany({ where: { id: otherDefectId } }),
    });
    expect(rows).toHaveLength(0);
  });

  it('revokes access immediately after unassign and restores it on reassignment', async () => {
    await owner.propertyObjectEngineer.update({
      where: { id: assignmentId },
      data: { unassignedAt: new Date() },
    });
    const hidden = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: responsibleId, sessionVersion: 1 },
      callback: (tx) => tx.act.findMany({ where: { id: actId } }),
    });
    expect(hidden).toHaveLength(0);
    await owner.propertyObjectEngineer.update({
      where: { id: assignmentId },
      data: { unassignedAt: null },
    });
    const restored = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: responsibleId, sessionVersion: 1 },
      callback: (tx) => tx.act.findMany({ where: { id: actId } }),
    });
    expect(restored).toHaveLength(1);
  });

  it('hides proposal B/C from RESPONSIBLE_ENGINEER at row level', async () => {
    const rows = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: responsibleId, sessionVersion: 1 },
      callback: async (tx) => ({
        a: await tx.proposal.findMany({ where: { id: proposalAId } }),
        b: await tx.proposal.findMany({ where: { id: proposalBId } }),
      }),
    });
    expect(rows.a).toHaveLength(1);
    expect(rows.b).toHaveLength(0);
  });

  it('blocks CONTRACTOR_ENGINEER from reading audit_logs over SQL', async () => {
    const rows = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: contractorId, sessionVersion: 1 },
      callback: (tx) => tx.auditLog.findMany({ where: { entityId: actId } }),
    });
    expect(rows).toHaveLength(0);
  });

  it('keeps ADMIN and SGR_MANAGER access to business rows', async () => {
    const adminRows = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: (tx) => tx.act.findMany({ where: { id: { in: [actId, otherActId] } } }),
    });
    const managerRows = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: managerId, sessionVersion: 1 },
      callback: (tx) => tx.proposal.findMany({ where: { id: proposalBId } }),
    });
    expect(adminRows).toHaveLength(2);
    expect(managerRows).toHaveLength(1);
  });

  it('isolates AUTH from business tables and API from the RLS secret', async () => {
    const acts = await sql(authUrl, 'SELECT id FROM acts LIMIT 1');
    expect(acts.error).toBeTruthy();
    const businessAudit = await sql(
      authUrl,
      'SELECT id FROM audit_logs WHERE "entityType" = $1 LIMIT 1',
      ['ACT'],
    );
    expect(businessAudit.error).toBeUndefined();
    expect(businessAudit.rows).toHaveLength(0);
    const loginAudit = await sql(
      authUrl,
      `INSERT INTO audit_logs (id, action, "entityType", "entityId", "occurredAt")
       VALUES (gen_random_uuid(), 'LOGIN_FAILED', 'USER', 'unknown', now())
       RETURNING id`,
    );
    expect(loginAudit.error).toBeUndefined();
    expect(loginAudit.rows).toHaveLength(1);
    const roleUpdate = await sql(authUrl, `UPDATE users SET role = 'ADMIN' WHERE id = $1`, [
      adminId,
    ]);
    expect(roleUpdate.error).toBeTruthy();
    const secretRows = await sql(appUrl, 'SELECT secret FROM sgr_rls_secrets LIMIT 1');
    expect(secretRows.error).toBeTruthy();
    expect(secretRows.rows).toHaveLength(0);
  });

  it('lets WORKER read claimed work only with worker context', async () => {
    const bare = await sql(workerUrl, 'SELECT id FROM acts WHERE id = $1', [actId]);
    expect(bare.rows).toHaveLength(0);
    const workerPrisma = createPrismaClient(workerUrl);
    try {
      const rows = await withWorkerDbContext({
        prisma: workerPrisma,
        secret,
        callback: (tx) => tx.act.findMany({ where: { id: actId } }),
      });
      expect(rows).toHaveLength(1);
    } finally {
      await workerPrisma.$disconnect();
    }
  });

  it('does not leak user A context onto the pooled connection used by user B', async () => {
    await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: responsibleId, sessionVersion: 1 },
      callback: async (tx) => tx.act.findMany({ where: { id: actId } }),
    });
    const leaked = await appPrisma.act.findMany({ where: { id: actId } });
    expect(leaked).toHaveLength(0);
    const parallel = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: async (tx) =>
        Promise.all([
          tx.act.findMany({ where: { id: actId } }),
          tx.proposal.findMany({ where: { id: proposalAId } }),
          tx.defectItem.findMany({ where: { id: defectId } }),
        ]),
    });
    expect(parallel[0]).toHaveLength(1);
    expect(parallel[1]).toHaveLength(1);
    expect(parallel[2]).toHaveLength(1);
    const other = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: otherResponsibleId, sessionVersion: 1 },
      callback: (tx) => tx.act.findMany({ where: { id: actId } }),
    });
    expect(other).toHaveLength(0);
  });

  it('clears context after rollback and does not allow runtime roles to disable RLS', async () => {
    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: responsibleId, sessionVersion: 1 },
        callback: async (tx) => {
          await tx.act.findMany({ where: { id: actId } });
          throw new Error('rollback-probe');
        },
      }),
    ).rejects.toThrow('rollback-probe');
    const afterRollback = await appPrisma.act.findMany({ where: { id: actId } });
    expect(afterRollback).toHaveLength(0);
    const disable = await sql(appUrl, 'ALTER TABLE acts DISABLE ROW LEVEL SECURITY');
    expect(disable.error).toBeTruthy();
    const setOwner = await sql(appUrl, 'SET ROLE sgr_owner');
    expect(setOwner.error).toBeTruthy();
  });

  it('allows audit insert and forbids runtime updates of audit_logs', async () => {
    const inserted = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: (tx) =>
        tx.auditLog.create({
          data: {
            action: 'ACT_CREATED',
            entityType: 'ACT',
            entityId: actId,
            source: 'WEB',
          },
        }),
    });
    expect(inserted.id).toBeTruthy();
    const updated = await sql(appUrl, 'UPDATE audit_logs SET action = $1 WHERE id = $2', [
      'TAMPER',
      inserted.id,
    ]);
    expect(updated.error).toBeTruthy();
  });
});
