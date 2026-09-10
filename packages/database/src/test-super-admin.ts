import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { PrismaClient } from '@prisma/client';
import {
  assertPasswordPolicy,
  CONFIRMED_LAST_FIRST_TOKEN_ORDER,
  personNameWriteFields,
} from '@sgr-registry/domain';
import { assertE2eDatabaseTarget } from './e2e-target';
import { SUPER_ADMIN_ADVISORY_LOCK_KEY1, SUPER_ADMIN_ADVISORY_LOCK_KEY2 } from './super-admin-lock';
import { upsertUserCredentials } from './user-credentials';

export const TEST_SUPER_ADMIN_EMAIL = 'super.admin@example.sgr.local';
export const TEST_SUPER_ADMIN_NAME = 'Суперадминистратор теста';

export async function ensureTestSuperAdmin(options: {
  owner: PrismaClient;
  password: string;
  email?: string;
  fullName?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ id: string; email: string }> {
  assertE2eDatabaseTarget(options.env ?? process.env);
  const email = (options.email ?? TEST_SUPER_ADMIN_EMAIL).trim().toLowerCase();
  const fullName = options.fullName ?? TEST_SUPER_ADMIN_NAME;
  assertPasswordPolicy(options.password, { email, fullName });
  const passwordHash = await argon2.hash(options.password, { type: argon2.argon2id });
  const now = new Date();
  return options.owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      ${SUPER_ADMIN_ADVISORY_LOCK_KEY1},
      ${SUPER_ADMIN_ADVISORY_LOCK_KEY2}
    )`;
    await tx.user.updateMany({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE', email: { not: email } },
      data: { status: 'ARCHIVED', archivedAt: now, sessionVersion: { increment: 1 } },
    });
    const existing = await tx.user.findUnique({ where: { email } });
    if (existing && existing.role !== 'SUPER_ADMIN') {
      throw new Error('Test super-admin email is already used by another role');
    }
    if (existing) {
      const updated = await tx.user.update({
        where: { id: existing.id },
        data: {
          ...personNameWriteFields(fullName, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
          archivedAt: null,
          mustChangePassword: false,
          sessionVersion: { increment: 1 },
        },
      });
      await upsertUserCredentials(tx, {
        userId: updated.id,
        passwordHash,
        passwordChangedAt: now,
      });
      return { id: updated.id, email: updated.email };
    }
    const created = await tx.user.create({
      data: {
        id: randomUUID(),
        ...personNameWriteFields(fullName, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
        email,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        mustChangePassword: false,
      },
    });
    await upsertUserCredentials(tx, {
      userId: created.id,
      passwordHash,
      passwordChangedAt: now,
    });
    return { id: created.id, email: created.email };
  });
}
