import argon2 from 'argon2';
import Redis from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import {
  assertPasswordPolicy,
  normalizeUserEmail,
  normalizeUserFullName,
} from '@sgr-registry/domain';
import { insertAuditLogRow } from './rls-writes';
import { SUPER_ADMIN_ADVISORY_LOCK_KEY1, SUPER_ADMIN_ADVISORY_LOCK_KEY2 } from './super-admin-lock';
import { upsertUserCredentials } from './user-credentials';

export type SuperAdminProvisionFailAfter = 'lock' | 'archive' | 'user' | 'credentials' | 'audit';

export type SuperAdminProvisionReason = 'created' | 'password-rotated' | 'replaced';

export class SuperAdminProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuperAdminProvisionError';
  }
}

export async function provisionSuperAdmin(input: {
  owner: PrismaClient;
  email: string;
  fullName: string;
  password: string;
  replace?: boolean;
  replaceConfirmEmail?: string;
  failAfter?: SuperAdminProvisionFailAfter;
}): Promise<{
  id: string;
  email: string;
  reason: SuperAdminProvisionReason;
  replacedUserId: string | null;
  replacedEmail: string | null;
}> {
  const email = normalizeUserEmail(input.email);
  const fullName = normalizeUserFullName(input.fullName);
  assertPasswordPolicy(input.password, { email, fullName });
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  const now = new Date();

  return input.owner.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(
        ${SUPER_ADMIN_ADVISORY_LOCK_KEY1},
        ${SUPER_ADMIN_ADVISORY_LOCK_KEY2}
      )`;
      if (input.failAfter === 'lock') {
        throw new SuperAdminProvisionError('injected failure after lock');
      }

      const active = await tx.$queryRaw<Array<{ id: string; email: string }>>`
        SELECT id, email
        FROM public.users
        WHERE role = 'SUPER_ADMIN'::public."UserRole"
          AND status = 'ACTIVE'::public."UserStatus"
        ORDER BY email
        FOR UPDATE
      `;
      if (active.length > 1) {
        throw new SuperAdminProvisionError(
          'Unexpected number of active SUPER_ADMIN rows; refusing to continue.',
        );
      }

      const current = active[0] ?? null;
      let replacedUserId: string | null = null;
      let replacedEmail: string | null = null;
      let reason: SuperAdminProvisionReason = 'created';

      if (current && current.email !== email) {
        if (!input.replace) {
          throw new SuperAdminProvisionError(
            'An active SUPER_ADMIN already exists. Re-run with --replace after confirmation.',
          );
        }
        const expected = input.replaceConfirmEmail?.trim().toLowerCase();
        if (!expected || expected !== current.email) {
          throw new SuperAdminProvisionError(
            'Replacement confirmation does not match the active SUPER_ADMIN email.',
          );
        }
        await tx.user.update({
          where: { id: current.id },
          data: {
            status: 'ARCHIVED',
            archivedAt: now,
            sessionVersion: { increment: 1 },
            version: { increment: 1 },
          },
        });
        replacedUserId = current.id;
        replacedEmail = current.email;
        reason = 'replaced';
        if (input.failAfter === 'archive') {
          throw new SuperAdminProvisionError('injected failure after archive');
        }
      } else if (current) {
        reason = 'password-rotated';
      }

      const existing = await tx.user.findUnique({ where: { email } });
      if (existing && existing.role !== 'SUPER_ADMIN') {
        throw new SuperAdminProvisionError('Target email is already used by another role');
      }

      const upserted = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: {
              fullName,
              role: 'SUPER_ADMIN',
              status: 'ACTIVE',
              archivedAt: null,
              mustChangePassword: false,
              sessionVersion: { increment: 1 },
              version: { increment: 1 },
            },
          })
        : await tx.user.create({
            data: {
              fullName,
              email,
              role: 'SUPER_ADMIN',
              status: 'ACTIVE',
              mustChangePassword: false,
            },
          });
      if (input.failAfter === 'user') {
        throw new SuperAdminProvisionError('injected failure after user');
      }

      await upsertUserCredentials(tx, {
        userId: upserted.id,
        passwordHash,
        passwordChangedAt: now,
      });
      if (input.failAfter === 'credentials') {
        throw new SuperAdminProvisionError('injected failure after credentials');
      }
      if (input.failAfter === 'audit') {
        throw new SuperAdminProvisionError('injected failure before audit');
      }

      await insertAuditLogRow(tx, {
        actorUserId: null,
        actorName: 'system',
        action: 'SUPER_ADMIN_PROVISIONED',
        entityType: 'USER',
        entityId: upserted.id,
        parentEntityType: null,
        parentEntityId: null,
        oldValue: replacedEmail ? { email: replacedEmail, status: 'ARCHIVED' } : null,
        newValue: { email: upserted.email, role: 'SUPER_ADMIN' },
        reason,
        source: 'SYSTEM',
        occurredAt: now,
        ipAddress: null,
        requestId: null,
      });

      return {
        id: upserted.id,
        email: upserted.email,
        reason,
        replacedUserId,
        replacedEmail,
      };
    },
    { timeout: 20_000 },
  );
}

export async function revokeUserRedisSessions(input: {
  redisUrl: string;
  prefix: string;
  userId: string;
}): Promise<void> {
  const redis = new Redis(input.redisUrl, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  try {
    await redis.connect();
    const indexKey = `${input.prefix}:user-sess:${input.userId}`;
    const hashes = await redis.smembers(indexKey);
    if (hashes.length === 0) {
      return;
    }
    const pipeline = redis.pipeline();
    for (const hash of hashes) {
      pipeline.del(`${input.prefix}:sess:${hash}`);
    }
    pipeline.del(indexKey);
    await pipeline.exec();
  } finally {
    redis.disconnect();
  }
}
