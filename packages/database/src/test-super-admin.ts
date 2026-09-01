import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { PrismaClient } from '@prisma/client';
import { assertPasswordPolicy } from '@sgr-registry/domain';

export const TEST_SUPER_ADMIN_EMAIL = 'super.admin@example.sgr.local';
export const TEST_SUPER_ADMIN_NAME = 'Суперадминистратор теста';

export async function ensureTestSuperAdmin(options: {
  owner: PrismaClient;
  password: string;
  email?: string;
  fullName?: string;
}): Promise<{ id: string; email: string }> {
  assertPasswordPolicy(options.password);
  const email = (options.email ?? TEST_SUPER_ADMIN_EMAIL).trim().toLowerCase();
  const fullName = options.fullName ?? TEST_SUPER_ADMIN_NAME;
  const passwordHash = await argon2.hash(options.password, { type: argon2.argon2id });
  const now = new Date();
  await options.owner.user.updateMany({
    where: { role: 'SUPER_ADMIN', status: 'ACTIVE', email: { not: email } },
    data: { status: 'ARCHIVED', archivedAt: now, sessionVersion: { increment: 1 } },
  });
  const existing = await options.owner.user.findUnique({ where: { email } });
  if (existing && existing.role !== 'SUPER_ADMIN') {
    throw new Error('Test super-admin email is already used by another role');
  }
  if (existing) {
    const updated = await options.owner.user.update({
      where: { id: existing.id },
      data: {
        fullName,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        archivedAt: null,
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: now,
        sessionVersion: { increment: 1 },
      },
    });
    return { id: updated.id, email: updated.email };
  }
  const created = await options.owner.user.create({
    data: {
      id: randomUUID(),
      fullName,
      email,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      passwordHash,
      mustChangePassword: false,
      passwordChangedAt: now,
    },
  });
  return { id: created.id, email: created.email };
}
