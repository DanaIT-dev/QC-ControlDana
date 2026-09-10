import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { CONFIRMED_LAST_FIRST_TOKEN_ORDER, personNameWriteFields } from '@sgr-registry/domain';
import {
  createOwnerPrismaClient,
  createPrismaClient,
  postgresUrlWithoutSchema,
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
const MARKER = `mgr-${randomUUID().slice(0, 8)}`;

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

describe('MANAGER role and protected profile SQL', () => {
  let adminId = '';
  let managerId = '';
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
    const manager = await owner.user.create({
      data: {
        ...personNameWriteFields(`${MARKER} manager`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
        email: `${MARKER}.manager@example.sgr.local`,
        role: 'MANAGER',
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
    managerId = manager.id;
    engineerId = engineer.id;
    const object = await owner.propertyObject.create({
      data: { name: `${MARKER} object`, address: `${MARKER} address` },
    });
    objectId = object.id;
  });

  afterAll(async () => {
    await owner.propertyObject.deleteMany({ where: { id: objectId } }).catch(() => undefined);
    await owner.user
      .deleteMany({ where: { id: { in: [adminId, managerId, engineerId] } } })
      .catch(() => undefined);
    await owner.$disconnect();
    await appPrisma.$disconnect();
  });

  it('lets MANAGER read business rows like ADMIN', async () => {
    const rows = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: managerId, sessionVersion: 1 },
      callback: (tx) => tx.propertyObject.findMany({ where: { id: objectId } }),
    });
    expect(rows).toHaveLength(1);
  });

  it('rejects direct sgr_app updates of email and fullName', async () => {
    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: managerId, sessionVersion: 1 },
        callback: (tx) =>
          tx.user.update({
            where: { id: engineerId },
            data: { email: `${MARKER}.forged@example.sgr.local` },
          }),
      }),
    ).rejects.toThrow();
    const stored = await owner.user.findUniqueOrThrow({ where: { id: engineerId } });
    expect(stored.email).toBe(`${MARKER}.engineer@example.sgr.local`);
  });

  it('rejects forged context and allows the profile definer for a lower role', async () => {
    const forged = await sql(appUrl, `SELECT set_config('sgr.uid', $1, true)`, [managerId]);
    expect(forged.error ?? forged.rows).toBeTruthy();
    const direct = await sql(appUrl, `UPDATE users SET email = $1 WHERE id = $2`, [
      `${MARKER}.sql@example.sgr.local`,
      engineerId,
    ]);
    if (direct.error) {
      expect(direct.error).toMatch(/Недостаточно прав|42501|permission|row-level security|policy/i);
    } else {
      expect(direct.rowCount).toBe(0);
    }
    const afterDirect = await owner.user.findUniqueOrThrow({ where: { id: engineerId } });
    expect(afterDirect.email).toBe(`${MARKER}.engineer@example.sgr.local`);

    const engineer = await owner.user.findUniqueOrThrow({ where: { id: engineerId } });
    const admin = await owner.user.findUniqueOrThrow({ where: { id: adminId } });
    const updated = await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret,
      user: { id: managerId, sessionVersion: 1 },
      callback: (tx) =>
        tx.$queryRaw<Array<{ full_name: string; email_changed: boolean }>>`
          SELECT full_name, email_changed
          FROM public.sgr_update_user_profile(
            ${engineerId}::uuid,
            ${'Орлов'},
            ${'Дмитрий'},
            ${null},
            ${engineer.email},
            ${engineer.version}::integer,
            ${managerId}::uuid,
            ${`${MARKER} manager`},
            ${`${MARKER}-req`}
          )
        `,
    });
    expect(updated[0]?.full_name).toBe('Орлов Дмитрий');
    expect(updated[0]?.email_changed).toBe(false);

    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: managerId, sessionVersion: 1 },
        callback: (tx) =>
          tx.$queryRaw`
            SELECT * FROM public.sgr_update_user_profile(
              ${adminId}::uuid,
              ${'Запрет'},
              ${'Админ'},
              ${null},
              ${admin.email},
              ${admin.version}::integer,
              ${managerId}::uuid,
              ${`${MARKER} manager`},
              ${`${MARKER}-denied`}
            )
          `,
      }),
    ).rejects.toThrow();
  });
});
