import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CONFIRMED_LAST_FIRST_TOKEN_ORDER,
  formatPersonShort,
  personNameWriteFields,
} from '@sgr-registry/domain';
import { createOwnerPrismaClient, createPrismaClient } from '../../src/client';
import { upsertUserCredentials } from '../../src/user-credentials';
import { withAuthenticatedDbContext } from '../../src/authenticated-context';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const appUrl = process.env.DATABASE_URL ?? '';
const secret = process.env.RLS_CONTEXT_SECRET ?? '';
assertSafeTestDatabaseUrl(databaseUrl);
assertSafeTestDatabaseUrl(appUrl);

const prisma = createOwnerPrismaClient(databaseUrl);
const appPrisma = createPrismaClient(appUrl);
const MARKER = `ncorr-${randomUUID().slice(0, 8)}`;

describe('user name structure correction', () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    const leftover = await prisma.user.findMany({
      where: { email: { startsWith: 'ncorr-' } },
      select: { id: true },
    });
    const userIds = [...new Set([...createdUserIds, ...leftover.map((row) => row.id)])];
    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only',
    );
    try {
      if (userIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: {
            OR: [{ entityId: { in: userIds } }, { actorUserId: { in: userIds } }],
          },
        });
      }
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only',
      );
    }
    if (userIds.length > 0) {
      await prisma.userCredential.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });

  it('corrects a confirmed two-token name without touching credentials', async () => {
    const swapped = personNameWriteFields('Мария Ковалева', CONFIRMED_LAST_FIRST_TOKEN_ORDER);
    expect(swapped.lastName).toBe('Мария');
    const user = await prisma.user.create({
      data: {
        ...swapped,
        email: `${MARKER}.kovalyova@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
        status: 'ACTIVE',
        sessionVersion: 1,
      },
    });
    createdUserIds.push(user.id);
    await upsertUserCredentials(prisma, { userId: user.id, passwordHash: `${MARKER}-hash` });
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { credentials: true },
    });
    const rows = await prisma.$queryRaw<
      Array<{
        last_name: string;
        first_name: string;
        middle_name: string | null;
        full_name: string;
        session_version: number;
      }>
    >`
      SELECT last_name, first_name, middle_name, full_name, session_version
      FROM public.sgr_correct_user_name_structure(
        ${user.id}::uuid,
        ${'Ковалева'},
        ${'Мария'},
        ${null}
      )
    `;
    expect(rows[0]).toMatchObject({
      last_name: 'Ковалева',
      first_name: 'Мария',
      middle_name: null,
      full_name: 'Ковалева Мария',
      session_version: 1,
    });
    expect(formatPersonShort({ lastName: 'Ковалева', firstName: 'Мария', middleName: null })).toBe(
      'Ковалева М.',
    );
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { credentials: true },
    });
    expect(after.email).toBe(before.email);
    expect(after.role).toBe(before.role);
    expect(after.status).toBe(before.status);
    expect(after.sessionVersion).toBe(before.sessionVersion);
    expect(after.credentials?.passwordHash).toBe(before.credentials?.passwordHash);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: user.id, action: 'USER_NAME_STRUCTURE_CORRECTED' },
    });
    expect(JSON.stringify(audit)).not.toMatch(/email|passwordHash|csrf|session/i);
    expect(audit.oldValue).toMatchObject({
      lastName: 'Мария',
      firstName: 'Ковалева',
      fullName: 'Мария Ковалева',
    });
    expect(audit.newValue).toMatchObject({
      lastName: 'Ковалева',
      firstName: 'Мария',
      fullName: 'Ковалева Мария',
    });

    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret,
        user: { id: user.id, sessionVersion: 1 },
        callback: (tx) =>
          tx.$queryRaw`
            SELECT * FROM public.sgr_correct_user_name_structure(
              ${user.id}::uuid,
              ${'Ковалева'},
              ${'Мария'},
              ${null}
            )
          `,
      }),
    ).rejects.toThrow();
  });
});
