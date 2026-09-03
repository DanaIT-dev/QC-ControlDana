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
const workerPrisma = createPrismaClient(workerUrl);

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
        startedAt: new Date('2026-01-15T12:00:00.000Z'),
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
        startedAt: new Date('2026-01-16T12:00:00.000Z'),
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
      await owner.attachment.deleteMany({ where: { proposalId: { in: proposalIds } } });
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
      await owner.actChatMention.deleteMany({ where: { message: { actId: { in: actIds } } } });
      await owner.actChatMessage.deleteMany({ where: { actId: { in: actIds } } });
      await owner.notificationRecipient.deleteMany({
        where: { event: { actId: { in: actIds } } },
      });
      await owner.notificationEvent.deleteMany({ where: { actId: { in: actIds } } });
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
    const markerUsers = await owner.user.findMany({
      where: { OR: [{ email: { contains: MARKER } }, { fullName: { startsWith: MARKER } }] },
      select: { id: true },
    });
    const markerUserIds = markerUsers.map((row) => row.id);
    await owner.$executeRawUnsafe(
      'ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only',
    );
    try {
      await owner.auditLog.deleteMany({
        where: {
          OR: [
            ...(markerUserIds.length > 0 ? [{ actorUserId: { in: markerUserIds } }] : []),
            ...(objectIds.length > 0 ? [{ entityId: { in: objectIds } }] : []),
            { requestId: { startsWith: MARKER } },
            { actorName: { startsWith: MARKER } },
          ],
        },
      });
    } finally {
      await owner.$executeRawUnsafe(
        'ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only',
      );
    }
    if (markerUserIds.length > 0) {
      await owner.user.deleteMany({ where: { id: { in: markerUserIds } } });
    }
    await owner.$disconnect();
    await appPrisma.$disconnect();
    await workerPrisma.$disconnect();
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

  it('blocks direct object INSERT and lets staff create only through the definer', async () => {
    const name = `${MARKER} manual-object`;
    const denied = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: async (tx) => {
        try {
          await tx.propertyObject.create({
            data: { name, address: 'ул. Прямая, 1', sortOrder: 1 },
          });
          return 'inserted';
        } catch {
          return 'denied';
        }
      },
    });
    expect(denied).toBe('denied');
    expect(await owner.propertyObject.findFirst({ where: { name } })).toBeNull();

    const created = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string; name: string }>>`
          SELECT id, name FROM public.sgr_create_property_object(
            ${name},
            ${'ул. Прямая, 1'},
            NULL,
            NULL,
            NULL,
            ${'Василевич М.В.'},
            ${adminId}::uuid,
            ${`${MARKER} admin`},
            ${`${MARKER}-rls`}
          )
        `;
        return rows[0];
      },
    });
    expect(created?.name).toBe(name);
    if (created?.id) {
      await owner.propertyObjectEngineer.deleteMany({ where: { propertyObjectId: created.id } });
      await owner.propertyObject.deleteMany({ where: { id: created.id } });
    }

    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: responsibleId, sessionVersion: 1 },
        callback: (tx) =>
          tx.$queryRaw`
            SELECT id FROM public.sgr_create_property_object(
              ${`${name}-eng`},
              NULL, NULL, NULL, NULL, NULL,
              ${responsibleId}::uuid,
              ${'engineer'},
              ${`${MARKER}-eng`}
            )
          `,
      }),
    ).rejects.toThrow();
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

  it('hides act chat from contractors and unverified connections', async () => {
    const created = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: async (tx) =>
        tx.actChatMessage.create({
          data: {
            actId,
            authorId: adminId,
            body: 'Внутреннее сообщение',
            clientMessageId: randomUUID(),
          },
        }),
    });
    const open = await sql(appUrl, 'SELECT id FROM act_chat_messages WHERE id = $1', [created.id]);
    expect(open.rows).toHaveLength(0);
    const contractorRows = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: contractorId, sessionVersion: 1 },
      callback: (tx) => tx.actChatMessage.findMany({ where: { actId } }),
    });
    expect(contractorRows).toHaveLength(0);
    const responsibleRows = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: responsibleId, sessionVersion: 1 },
      callback: (tx) => tx.actChatMessage.findMany({ where: { actId } }),
    });
    expect(responsibleRows).toHaveLength(1);
    const foreignRows = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: otherResponsibleId, sessionVersion: 1 },
      callback: (tx) => tx.actChatMessage.findMany({ where: { actId } }),
    });
    expect(foreignRows).toHaveLength(0);
    const updated = await sql(appUrl, 'UPDATE act_chat_messages SET body = $1 WHERE id = $2', [
      'tamper',
      created.id,
    ]);
    expect(updated.error).toBeTruthy();
    const deleted = await sql(appUrl, 'DELETE FROM act_chat_messages WHERE id = $1', [created.id]);
    expect(deleted.error).toBeTruthy();
    const workerChat = await sql(workerUrl, 'SELECT id FROM act_chat_messages WHERE id = $1', [
      created.id,
    ]);
    expect(workerChat.error).toBeTruthy();
  });

  it('blocks contractor SQL updates of non-deadline fields and B/C attachment writes by responsible', async () => {
    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: contractorId, sessionVersion: 1 },
        callback: (tx) =>
          tx.defectItem.update({
            where: { id: defectId },
            data: { status: 'COMPLETED' },
          }),
      }),
    ).rejects.toThrow();
    const thirdParty = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: contractorId, sessionVersion: 1 },
      callback: (tx) =>
        tx.defectItem.update({
          where: { id: defectId },
          data: { thirdPartyDeadline: new Date('2026-12-01T12:00:00.000Z') },
        }),
    });
    expect(thirdParty.id).toBe(defectId);

    const hidden = await owner.attachment.create({
      data: {
        proposalId: proposalBId,
        originalFilename: 'bc.pdf',
        safeDisplayName: 'bc.pdf',
        objectKey: null,
        bucket: 'sgr-rls-audit',
        sizeBytes: 12,
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        sha256: `rls-bc-${randomUUID()}`,
        category: 'PROPOSAL_DOCUMENT',
        status: 'READY',
        uploadedById: adminId,
      },
    });
    try {
      const updated = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: responsibleId, sessionVersion: 1 },
        callback: (tx) =>
          tx.attachment.updateMany({
            where: { id: hidden.id },
            data: { archiveReason: 'tamper' },
          }),
      });
      expect(updated.count).toBe(0);
      const staffUpdated = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: adminId, sessionVersion: 1 },
        callback: (tx) =>
          tx.attachment.updateMany({
            where: { id: hidden.id },
            data: { archiveReason: 'audit' },
          }),
      });
      expect(staffUpdated.count).toBe(1);
    } finally {
      await owner.attachment.deleteMany({ where: { id: hidden.id } });
    }
  });

  it('rolls back chat rows together with mentions and does not leak RLS context', async () => {
    const clientMessageId = randomUUID();
    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: adminId, sessionVersion: 1 },
        callback: async (tx) => {
          const message = await tx.actChatMessage.create({
            data: {
              actId,
              authorId: adminId,
              body: 'Откат',
              clientMessageId,
            },
          });
          await tx.actChatMention.create({
            data: { messageId: message.id, userId: managerId },
          });
          throw new Error('chat-rollback');
        },
      }),
    ).rejects.toThrow('chat-rollback');
    const leftover = await owner.actChatMessage.findMany({
      where: { clientMessageId },
    });
    expect(leftover).toHaveLength(0);
    const leaked = await appPrisma.actChatMessage.findMany({ where: { actId } });
    expect(leaked).toHaveLength(0);
  });

  it('gives SUPER_ADMIN read-only business data without password hashes', async () => {
    await owner.user.updateMany({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    const superAdmin = await owner.user.create({
      data: {
        fullName: `${MARKER} super-admin`,
        email: `${MARKER}.super@example.sgr.local`,
        role: 'SUPER_ADMIN',
        sessionVersion: 1,
      },
    });
    const pending = await owner.user.create({
      data: {
        fullName: `${MARKER} pending`,
        email: `${MARKER}.pending@example.sgr.local`,
        role: 'PENDING_ROLE',
        sessionVersion: 1,
      },
    });
    try {
      await owner.actChatMessage.create({
        data: {
          actId,
          authorId: adminId,
          body: 'Oversight chat',
          clientMessageId: randomUUID(),
        },
      });
      const visible = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: superAdmin.id, sessionVersion: 1 },
        callback: async (tx) => ({
          acts: await tx.act.findMany({ where: { id: { in: [actId, otherActId] } } }),
          defects: await tx.defectItem.findMany({
            where: { id: { in: [defectId, otherDefectId] } },
          }),
          proposals: await tx.proposal.findMany({
            where: { id: { in: [proposalAId, proposalBId] } },
          }),
          users: await tx.user.findMany(),
          objects: await tx.propertyObject.findMany({ where: { id: objectId } }),
          orgs: await tx.organization.findMany({
            where: { email: `${MARKER}.org@example.sgr.local` },
          }),
          audit: await tx.auditLog.findMany({ where: { entityId: actId } }),
          chat: await tx.actChatMessage.findMany({ where: { actId } }),
          assignments: await tx.propertyObjectEngineer.findMany({
            where: { propertyObjectId: objectId },
          }),
        }),
      });
      expect(visible.acts).toHaveLength(2);
      expect(visible.defects.length).toBeGreaterThan(0);
      expect(visible.proposals.length).toBeGreaterThan(0);
      expect(visible.users.length).toBeGreaterThan(0);
      expect(visible.objects).toHaveLength(1);
      expect(visible.orgs.length).toBeGreaterThan(0);
      expect(visible.audit.length).toBeGreaterThan(0);
      expect(visible.chat.length).toBeGreaterThan(0);
      expect(visible.assignments.length).toBeGreaterThan(0);

      const pendingView = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: pending.id, sessionVersion: 1 },
        callback: async (tx) => ({
          acts: await tx.act.findMany({ where: { id: { in: [actId, otherActId] } } }),
          defects: await tx.defectItem.findMany({ where: { id: defectId } }),
        }),
      });
      expect(pendingView.acts).toHaveLength(0);
      expect(pendingView.defects).toHaveLength(0);

      await expect(
        withAuthenticatedDbContext({
          prisma: appPrisma,
          secret,
          user: { id: superAdmin.id, sessionVersion: 1 },
          callback: (tx) => tx.act.update({ where: { id: actId }, data: { status: 'CANCELLED' } }),
        }),
      ).rejects.toThrow();

      const directory = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: superAdmin.id, sessionVersion: 1 },
        callback: (tx) =>
          tx.$queryRaw<Array<Record<string, unknown>>>`
            SELECT * FROM public.sgr_super_admin_directory('admins', null)
          `,
      });
      expect(directory.some((row) => row.id === adminId)).toBe(true);
      expect(JSON.stringify(directory)).not.toMatch(/passwordHash/);

      await expect(
        withAuthenticatedDbContext({
          prisma: appPrisma,
          secret,
          user: { id: superAdmin.id, sessionVersion: 1 },
          callback: async (tx) => {
            await tx.$queryRaw`
              SELECT * FROM public.sgr_grant_admin(${managerId}::uuid, ${1}::int)
            `;
            throw new Error('grant-rollback');
          },
        }),
      ).rejects.toThrow('grant-rollback');
      expect((await owner.user.findUniqueOrThrow({ where: { id: managerId } })).role).toBe(
        'SGR_MANAGER',
      );
    } finally {
      await owner.user.delete({ where: { id: pending.id } });
      await owner.user.delete({ where: { id: superAdmin.id } });
    }

    const hashSelect = await sql(appUrl, 'SELECT "passwordHash" FROM users LIMIT 1');
    expect(hashSelect.error).toBeTruthy();
    expect(hashSelect.rows).toHaveLength(0);

    const credentialsSelect = await sql(
      appUrl,
      'SELECT "passwordHash" FROM user_credentials LIMIT 1',
    );
    expect(credentialsSelect.error).toBeTruthy();
    expect(credentialsSelect.rows).toHaveLength(0);
    const appStar = await sql(appUrl, 'SELECT * FROM users LIMIT 1');
    expect(JSON.stringify(appStar.rows)).not.toMatch(/passwordHash/);
    const appCredStar = await sql(appUrl, 'SELECT * FROM user_credentials LIMIT 1');
    expect(appCredStar.error).toBeTruthy();
    const workerHash = await sql(workerUrl, 'SELECT "passwordHash" FROM user_credentials LIMIT 1');
    expect(workerHash.error).toBeTruthy();
    const authHash = await sql(authUrl, 'SELECT "passwordHash" FROM user_credentials LIMIT 1');
    expect(authHash.error).toBeUndefined();
    const contractorCreds = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: contractorId, sessionVersion: 1 },
      callback: async (tx) => {
        try {
          await tx.$executeRaw`
            SELECT public.sgr_upsert_user_credentials(${adminId}::uuid, 'not-a-real-hash')
          `;
          return 'updated';
        } catch {
          return 'denied';
        }
      },
    });
    expect(contractorCreds).toBe('denied');
    const noContextCreds = await sql(appUrl, 'SELECT * FROM user_credentials');
    expect(noContextCreds.error || noContextCreds.rows.length === 0).toBeTruthy();

    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: adminId, sessionVersion: 1 },
        callback: (tx) =>
          tx.user.update({
            where: { id: managerId },
            data: { role: 'ADMIN' },
          }),
      }),
    ).rejects.toThrow();
    expect((await owner.user.findUniqueOrThrow({ where: { id: managerId } })).role).toBe(
      'SGR_MANAGER',
    );

    const promoteSql = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: async (tx) => {
        try {
          await tx.$executeRaw`UPDATE users SET role = 'SUPER_ADMIN' WHERE id = ${managerId}::uuid`;
          return 'updated';
        } catch (error) {
          return error instanceof Error ? error.message : 'failed';
        }
      },
    });
    expect(promoteSql).not.toBe('updated');
    expect((await owner.user.findUniqueOrThrow({ where: { id: managerId } })).role).toBe(
      'SGR_MANAGER',
    );
  });

  it('does not grant global read without a verified request context', async () => {
    const acts = await sql(appUrl, 'SELECT id FROM public.acts LIMIT 5');
    expect(acts.rows).toHaveLength(0);
    const users = await sql(appUrl, 'SELECT id FROM public.users LIMIT 5');
    expect(users.rows).toHaveLength(0);
    await sql(
      appUrl,
      `SELECT set_config('sgr.role', 'SUPER_ADMIN', true), set_config('sgr.user_id', $1, true)`,
      [adminId],
    );
    const afterForge = await sql(appUrl, 'SELECT id FROM public.acts LIMIT 5');
    expect(afterForge.rows).toHaveLength(0);
  });

  it('scopes sla_clocks writes to object visibility and worker workflow', async () => {
    const sentinel = `rls-sla-${MARKER}`;
    await owner.propertyObjectEngineer.create({
      data: {
        propertyObjectId: otherObjectId,
        userId: otherResponsibleId,
        assignedByUserId: adminId,
      },
    });
    const clockA = await owner.slaClock.create({
      data: {
        defectItemId: defectId,
        kind: 'GENERAL',
        state: 'NORMAL',
        deadline: new Date('2026-09-15T12:00:00.000Z'),
      },
    });
    const clockB = await owner.slaClock.create({
      data: {
        defectItemId: otherDefectId,
        kind: 'GENERAL',
        state: 'NORMAL',
        deadline: new Date('2026-09-16T12:00:00.000Z'),
      },
    });
    try {
      const visible = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: responsibleId, sessionVersion: 1 },
        callback: (tx) => tx.slaClock.findMany({ where: { id: { in: [clockA.id, clockB.id] } } }),
      });
      expect(visible.map((row) => row.id)).toEqual([clockA.id]);

      const hidden = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: responsibleId, sessionVersion: 1 },
        callback: async (tx) => {
          try {
            await tx.slaClock.update({
              where: { id: clockB.id },
              data: { state: 'OVERDUE' },
            });
            return 'updated';
          } catch {
            return 'denied';
          }
        },
      });
      expect(hidden).toBe('denied');

      const insertB = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: responsibleId, sessionVersion: 1 },
        callback: async (tx) => {
          try {
            await tx.$executeRaw`
              SELECT public.sgr_upsert_sla_clock(
                ${null}::uuid,
                ${otherDefectId}::uuid,
                'THIRD_PARTY'::public."SlaClockKind",
                now(),
                1,
                'NORMAL'::public."SlaClockState",
                null,
                1
              )
            `;
            return 'inserted';
          } catch {
            return 'denied';
          }
        },
      });
      expect(insertB).toBe('denied');

      const move = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: responsibleId, sessionVersion: 1 },
        callback: async (tx) => {
          try {
            await tx.$executeRaw`
              UPDATE sla_clocks SET "defectItemId" = ${otherDefectId}::uuid WHERE id = ${clockA.id}::uuid
            `;
            return 'moved';
          } catch {
            return 'denied';
          }
        },
      });
      expect(move).toBe('denied');

      const deleted = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: responsibleId, sessionVersion: 1 },
        callback: async (tx) => {
          try {
            await tx.slaClock.delete({ where: { id: clockB.id } });
            return 'deleted';
          } catch {
            return 'denied';
          }
        },
      });
      expect(deleted).toBe('denied');

      const contractorWrite = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: contractorId, sessionVersion: 1 },
        callback: async (tx) => {
          try {
            await tx.$executeRaw`
              UPDATE sla_clocks SET state = 'OVERDUE' WHERE id = ${clockA.id}::uuid
            `;
            return 'updated';
          } catch {
            return 'denied';
          }
        },
      });
      expect(contractorWrite).toBe('denied');

      const contractorGeneral = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: contractorId, sessionVersion: 1 },
        callback: async (tx) => {
          try {
            await tx.$executeRaw`
              SELECT public.sgr_upsert_sla_clock(
                ${null}::uuid,
                ${defectId}::uuid,
                'GENERAL'::public."SlaClockKind",
                now(),
                1,
                'NORMAL'::public."SlaClockState",
                null,
                1
              )
            `;
            return 'inserted';
          } catch {
            return 'denied';
          }
        },
      });
      expect(contractorGeneral).toBe('denied');

      const superAdmin = await owner.user.create({
        data: {
          fullName: `${sentinel} sa`,
          email: `${sentinel}.sa@example.sgr.local`,
          role: 'SUPER_ADMIN',
          sessionVersion: 1,
        },
      });
      try {
        const saSelect = await withAuthenticatedDbContext({
          prisma: appPrisma,
          secret,
          user: { id: superAdmin.id, sessionVersion: 1 },
          callback: (tx) => tx.slaClock.findMany({ where: { id: clockA.id } }),
        });
        expect(saSelect).toHaveLength(1);
        const saWrite = await withAuthenticatedDbContext({
          prisma: appPrisma,
          secret,
          user: { id: superAdmin.id, sessionVersion: 1 },
          callback: async (tx) => {
            try {
              await tx.$executeRaw`
                SELECT public.sgr_upsert_sla_clock(
                  ${clockA.id}::uuid,
                  ${defectId}::uuid,
                  'GENERAL'::public."SlaClockKind",
                  now(),
                  9,
                  'OVERDUE'::public."SlaClockState",
                  null,
                  9
                )
              `;
              return 'updated';
            } catch {
              return 'denied';
            }
          },
        });
        expect(saWrite).toBe('denied');
      } finally {
        await owner.user.delete({ where: { id: superAdmin.id } });
      }

      const authSla = await sql(authUrl, 'SELECT * FROM sla_clocks LIMIT 1');
      expect(authSla.error || authSla.rows.length === 0).toBeTruthy();

      const workerOk = await withWorkerDbContext({
        prisma: workerPrisma,
        secret,
        callback: async (tx) => {
          await tx.$executeRaw`
            SELECT public.sgr_upsert_sla_clock(
              ${clockA.id}::uuid,
              ${defectId}::uuid,
              'GENERAL'::public."SlaClockKind",
              now(),
              2,
              'WARNING'::public."SlaClockState",
              null,
              2
            )
          `;
          return 'ok';
        },
      });
      expect(workerOk).toBe('ok');

      const bulk = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: responsibleId, sessionVersion: 1 },
        callback: async (tx) => {
          try {
            return await tx.slaClock.updateMany({
              where: { id: { in: [clockA.id, clockB.id] } },
              data: { state: 'OVERDUE' },
            });
          } catch {
            return { count: 0 };
          }
        },
      });
      expect(bulk.count).toBe(0);
      expect((await owner.slaClock.findUniqueOrThrow({ where: { id: clockB.id } })).state).toBe(
        'NORMAL',
      );

      const noContext = await sql(appUrl, `UPDATE sla_clocks SET cycle = 9 WHERE id = $1`, [
        clockB.id,
      ]);
      expect(noContext.error || (noContext.rows?.length ?? 0) === 0).toBeTruthy();
      expect((await owner.slaClock.findUniqueOrThrow({ where: { id: clockB.id } })).cycle).toBe(1);

      const forgedPool = new Pool({ connectionString: postgresUrlWithoutSchema(appUrl), max: 1 });
      const forgedClient = await forgedPool.connect();
      try {
        const forgedToken = signUserRlsContext(
          { userId: responsibleId, sessionVersion: 1, nonce: randomUUID() },
          'x'.repeat(32),
        );
        let forgedResult = 'denied';
        try {
          await forgedClient.query('SELECT public.sgr_set_request_context($1)', [forgedToken]);
          forgedResult = 'context-accepted';
        } catch {
          try {
            await forgedClient.query(
              `SELECT public.sgr_upsert_sla_clock($1::uuid, $2::uuid, 'GENERAL'::public."SlaClockKind", now(), 1, 'NORMAL'::public."SlaClockState", null, 1)`,
              [clockA.id, defectId],
            );
            forgedResult = 'upserted';
          } catch {
            forgedResult = 'denied';
          }
        }
        expect(forgedResult).toBe('denied');
      } finally {
        forgedClient.release();
        await forgedPool.end();
      }

      const authUpsert = await sql(
        authUrl,
        `SELECT public.sgr_upsert_sla_clock($1::uuid, $2::uuid, 'GENERAL'::public."SlaClockKind", now(), 1, 'NORMAL'::public."SlaClockState", null, 1)`,
        [clockA.id, defectId],
      );
      expect(authUpsert.error).toBeTruthy();

      await owner.propertyObjectEngineer.updateMany({
        where: { propertyObjectId: objectId, userId: responsibleId },
        data: { unassignedAt: new Date() },
      });
      const afterRevoke = await withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: responsibleId, sessionVersion: 1 },
        callback: (tx) => tx.slaClock.findMany({ where: { id: clockA.id } }),
      });
      expect(afterRevoke).toHaveLength(0);
      await owner.propertyObjectEngineer.updateMany({
        where: { propertyObjectId: objectId, userId: responsibleId },
        data: { unassignedAt: null },
      });
    } finally {
      await owner.slaClock.deleteMany({ where: { id: { in: [clockA.id, clockB.id] } } });
      await owner.propertyObjectEngineer.deleteMany({
        where: { propertyObjectId: otherObjectId, userId: otherResponsibleId },
      });
    }
  });

  it('starts acts only for staff or assigned responsible engineers', async () => {
    const newAct = await owner.act.create({
      data: {
        officialNumber: `${MARKER}-new`,
        formCode: 'S1',
        year: 2099,
        sequence: Math.floor(Math.random() * 800_000) + 200_000,
        objectId,
        customerOrganizationId: (await owner.act.findUniqueOrThrow({ where: { id: actId } }))
          .customerOrganizationId,
        issuedOn: new Date('2026-09-01T12:00:00.000Z'),
        status: 'NEW',
      },
    });
    const defectType = await owner.defectType.findUniqueOrThrow({ where: { code: 'RLS_TEST' } });
    const newDefect = await owner.defectItem.create({
      data: {
        actId: newAct.id,
        location: 'new',
        claimDetails: 'claim',
        defectTypeId: defectType.id,
      },
    });

    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: contractorId, sessionVersion: 1 },
        callback: (tx) =>
          tx.$queryRaw`SELECT * FROM public.sgr_start_act(${newAct.id}::uuid, 'rls-contractor')`,
      }),
    ).rejects.toThrow();

    const superAdmin = await owner.user.findFirst({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
    });
    if (superAdmin) {
      await expect(
        withAuthenticatedDbContext({
          prisma: appPrisma,
          secret,
          user: { id: superAdmin.id, sessionVersion: superAdmin.sessionVersion },
          callback: (tx) =>
            tx.$queryRaw`SELECT * FROM public.sgr_start_act(${newAct.id}::uuid, 'rls-super')`,
        }),
      ).rejects.toThrow();
    }

    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: otherResponsibleId, sessionVersion: 1 },
        callback: (tx) =>
          tx.$queryRaw`SELECT * FROM public.sgr_start_act(${newAct.id}::uuid, 'rls-foreign')`,
      }),
    ).rejects.toThrow();

    const completeNew = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: async (tx) => {
        try {
          await tx.defectItem.update({
            where: { id: newDefect.id },
            data: { status: 'COMPLETED' },
          });
          return 'updated';
        } catch {
          return 'denied';
        }
      },
    });
    expect(completeNew).toBe('denied');
    expect((await owner.defectItem.findUniqueOrThrow({ where: { id: newDefect.id } })).status).toBe(
      'IN_PROGRESS',
    );

    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: responsibleId, sessionVersion: 1 },
        callback: async (tx) => {
          const rows = await tx.$queryRaw<
            Array<{ status: string; already_started: boolean; started_by_id: string }>
          >`
            SELECT status, already_started, started_by_id
            FROM public.sgr_start_act(${newAct.id}::uuid, 'rls-responsible')
          `;
          expect(rows[0]?.status).toBe('IN_PROGRESS');
          expect(rows[0]?.already_started).toBe(false);
          expect(rows[0]?.started_by_id).toBe(responsibleId);
          throw new Error('start-rollback');
        },
      }),
    ).rejects.toThrow('start-rollback');
    expect((await owner.act.findUniqueOrThrow({ where: { id: newAct.id } })).status).toBe('NEW');
    expect(
      await owner.auditLog.count({ where: { entityId: newAct.id, action: 'ACT_STARTED' } }),
    ).toBe(0);

    await owner.act.update({
      where: { id: newAct.id },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    });
    const repeat = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: (tx) =>
        tx.$queryRaw<Array<{ already_started: boolean }>>`
          SELECT already_started
          FROM public.sgr_start_act(${newAct.id}::uuid, 'rls-repeat')
        `,
    });
    expect(repeat[0]?.already_started).toBe(true);
    expect(
      await owner.auditLog.count({ where: { entityId: newAct.id, action: 'ACT_STARTED' } }),
    ).toBe(0);

    const noContext = await sql(
      appUrl,
      `SELECT * FROM public.sgr_start_act($1::uuid, 'no-context')`,
      [newAct.id],
    );
    expect(noContext.error).toBeTruthy();

    const spoofStart = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: responsibleId, sessionVersion: 1 },
      callback: async (tx) => {
        try {
          await tx.act.update({
            where: { id: newAct.id },
            data: { startedAt: new Date(), startedById: responsibleId },
          });
          return 'updated';
        } catch {
          return 'denied';
        }
      },
    });
    expect(spoofStart).toBe('denied');

    await owner.defectItem.delete({ where: { id: newDefect.id } });
    await owner.act.delete({ where: { id: newAct.id } });
  });
});
