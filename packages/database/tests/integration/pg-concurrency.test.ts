import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  createOwnerPrismaClient,
  createPrismaClient,
  postgresUrlWithoutSchema,
  prismaWithRlsTransaction,
  serializePoolClientQueries,
  withAuthenticatedDbContext,
} from '../../src/index';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';
import { pgQueryDeprecationWarnings } from '../pg-warning-guard';

const appUrl = process.env.DATABASE_URL ?? '';
const migratorUrl = process.env.MIGRATION_DATABASE_URL ?? '';
const secret = process.env.RLS_CONTEXT_SECRET ?? '';

assertSafeTestDatabaseUrl(appUrl);
assertSafeTestDatabaseUrl(migratorUrl);

const owner = createOwnerPrismaClient(migratorUrl);
const appPrisma = createPrismaClient(appUrl);
const MARKER = `pgc-${randomUUID().slice(0, 8)}`;

describe('RLS transaction pg concurrency', () => {
  let adminId = '';
  let otherId = '';
  let actId = '';
  let defectId = '';

  afterAll(async () => {
    if (defectId) {
      await owner.defectItem.deleteMany({ where: { id: defectId } }).catch(() => undefined);
    }
    if (actId) {
      await owner.act.deleteMany({ where: { id: actId } }).catch(() => undefined);
    }
    await owner.user
      .deleteMany({ where: { fullName: { startsWith: MARKER } } })
      .catch(() => undefined);
    await owner.$disconnect();
    await appPrisma.$disconnect();
  });

  it('sets up users and an act with nested relations', async () => {
    const admin = await owner.user.create({
      data: {
        fullName: `${MARKER} admin`,
        email: `${MARKER}.admin@example.sgr.local`,
        role: 'ADMIN',
        sessionVersion: 1,
      },
    });
    const other = await owner.user.create({
      data: {
        fullName: `${MARKER} other`,
        email: `${MARKER}.other@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
        sessionVersion: 1,
      },
    });
    adminId = admin.id;
    otherId = other.id;
    const object = await owner.propertyObject.create({
      data: { name: `${MARKER} object`, address: `${MARKER} address` },
    });
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
        objectId: object.id,
        customerOrganizationId: org.id,
        issuedOn: new Date('2026-01-15T12:00:00.000Z'),
        status: 'IN_PROGRESS',
        startedAt: new Date('2026-01-15T12:00:00.000Z'),
      },
    });
    actId = act.id;
    const defectType = await owner.defectType.upsert({
      where: { code: 'PGC_TEST' },
      update: {},
      create: { code: 'PGC_TEST', name: 'PGC test type', sortOrder: 901, active: true },
    });
    const defect = await owner.defectItem.create({
      data: {
        actId,
        location: 'loc',
        claimDetails: 'claim',
        defectTypeId: defectType.id,
      },
    });
    defectId = defect.id;
    await owner.proposal.create({
      data: {
        defectItemId: defectId,
        slot: 'A',
        alternativeContractorOrganizationId: org.id,
        amount: 10,
      },
    });
    expect(adminId).toBeTruthy();
  });

  it('runs several queries in one authenticated transaction without a pg@9 warning', async () => {
    const started = Date.now();
    const [counts, nested] = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: async (tx) => {
        const summary = await Promise.all([
          tx.defectItem.count(),
          tx.defectItem.count({ where: { status: 'IN_PROGRESS' } }),
          tx.defectItem.count({ where: { status: 'COMPLETED' } }),
          tx.act.count(),
          tx.proposal.count(),
          tx.notificationRecipient.findMany({ take: 5, include: { event: true } }),
        ]);
        const acts = await tx.act.findMany({
          where: { id: actId },
          include: {
            defectItems: { include: { proposals: true, responsibleEngineers: true } },
          },
        });
        return [summary, acts] as const;
      },
    });
    expect(counts[0]).toBeGreaterThanOrEqual(1);
    expect(nested).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(pgQueryDeprecationWarnings()).toEqual([]);
  });

  it('rolls back on exception, commits on success, and does not leak RLS context', async () => {
    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: adminId, sessionVersion: 1 },
        callback: async (tx) => {
          await tx.act.findMany({ where: { id: actId } });
          throw new Error('pgc-rollback');
        },
      }),
    ).rejects.toThrow('pgc-rollback');
    const leaked = await appPrisma.act.findMany({ where: { id: actId } });
    expect(leaked).toHaveLength(0);
    const committed = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: (tx) => tx.act.findMany({ where: { id: actId } }),
    });
    expect(committed).toHaveLength(1);
    const other = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: otherId, sessionVersion: 1 },
      callback: (tx) => tx.act.findMany({ where: { id: actId } }),
    });
    expect(other).toHaveLength(0);
  });

  it('allows parallel requests from different users on different connections', async () => {
    const started = Date.now();
    const [adminRows, otherRows] = await Promise.all([
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: adminId, sessionVersion: 1 },
        callback: (tx) => tx.act.findMany({ where: { id: actId } }),
      }),
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: otherId, sessionVersion: 1 },
        callback: (tx) => tx.act.findMany({ where: { id: actId } }),
      }),
    ]);
    expect(adminRows).toHaveLength(1);
    expect(otherRows).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not globally serialize queries on different pooled connections', async () => {
    const pool = new Pool({
      connectionString: postgresUrlWithoutSchema(appUrl),
      max: 2,
    });
    const events: string[] = [];
    const first = await pool.connect();
    const second = await pool.connect();
    serializePoolClientQueries(first);
    serializePoolClientQueries(second);
    try {
      await Promise.all([
        (async () => {
          events.push('a-start');
          await first.query('SELECT pg_sleep(0.05)');
          events.push('a-end');
        })(),
        (async () => {
          events.push('b-start');
          await second.query('SELECT pg_sleep(0.05)');
          events.push('b-end');
        })(),
      ]);
      expect(events.indexOf('b-start')).toBeLessThan(events.indexOf('a-end'));
      expect(events.indexOf('a-start')).toBeLessThan(events.indexOf('b-end'));
    } finally {
      first.release();
      second.release();
      await pool.end();
    }
  });

  it('clears ALS after the transaction and reuses the pool', async () => {
    const scoped = prismaWithRlsTransaction(appPrisma);
    await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: async () => scoped.act.findMany({ where: { id: actId } }),
    });
    const after = await scoped.act.findMany({ where: { id: actId } });
    expect(after).toHaveLength(0);
    const again = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: adminId, sessionVersion: 1 },
      callback: (tx) => tx.act.findMany({ where: { id: actId } }),
    });
    expect(again).toHaveLength(1);
    expect(pgQueryDeprecationWarnings()).toEqual([]);
  });
});
