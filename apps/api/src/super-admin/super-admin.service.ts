import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  adminGrantRequestSchema,
  superAdminDirectoryQuerySchema,
  type SuperAdminDirectoryUser,
} from '@sgr-registry/contracts';
import {
  AdminGrantNotEligibleError,
  LastAdminRevokeError,
  roleLabel,
  StaleWriteError,
} from '@sgr-registry/domain';
import type { Prisma } from '@sgr-registry/database';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../auth/prisma.tokens';
import { RedisSessionStore } from '../auth/redis-session.store';
import { toJsonValue, writeAuditLog } from '../common/audit-writer';
import { parseCommandBody } from '../common/command-body';
import { actorContext } from '../common/request-context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DirectoryRow = {
  id: string;
  full_name: string;
  email: string;
  current_role: SuperAdminDirectoryUser['currentRole'];
  status: SuperAdminDirectoryUser['status'];
  archived_at: Date | null;
  version: number;
};

type GrantRow = DirectoryRow & {
  previous_role: SuperAdminDirectoryUser['currentRole'] | null;
};

@Injectable()
export class SuperAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisSessionStore) private readonly sessions: RedisSessionStore,
  ) {}

  listAdmins(rawQuery: Record<string, unknown>) {
    return this.listDirectory('admins', rawQuery);
  }

  listEligible(rawQuery: Record<string, unknown>) {
    return this.listDirectory('eligible', rawQuery);
  }

  async grant(
    actor: AuthenticatedUser,
    userId: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<SuperAdminDirectoryUser> {
    const targetId = parseUserId(userId);
    const input = parseCommandBody(adminGrantRequestSchema, body);
    const ctx = actorContext(actor, request);
    const result = await this.prisma.client.$transaction(async (tx) => {
      const row = await queryGrant(tx, targetId, input.expectedVersion);
      const changed = row.version !== input.expectedVersion;
      if (changed) {
        await writeAuditLog(tx, {
          ...ctx,
          action: 'ADMIN_GRANTED',
          entityType: 'USER',
          entityId: row.id,
          oldValue: toJsonValue({
            role: row.previous_role,
            targetUserId: row.id,
          }),
          newValue: toJsonValue({
            role: 'ADMIN',
            previousRole: row.previous_role,
            targetUserId: row.id,
          }),
        });
      }
      return { dto: toDirectoryDto(row, 'ACTIVE_ADMIN'), changed };
    });
    if (result.changed) {
      await this.sessions.deleteAllForUser(targetId);
    }
    return result.dto;
  }

  async revoke(
    actor: AuthenticatedUser,
    userId: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<SuperAdminDirectoryUser> {
    const targetId = parseUserId(userId);
    const input = parseCommandBody(adminGrantRequestSchema, body);
    const ctx = actorContext(actor, request);
    const result = await this.prisma.client.$transaction(async (tx) => {
      const row = await queryRevoke(tx, targetId, input.expectedVersion);
      const changed = row.version !== input.expectedVersion;
      if (changed) {
        await writeAuditLog(tx, {
          ...ctx,
          action: 'ADMIN_REVOKED',
          entityType: 'USER',
          entityId: row.id,
          oldValue: toJsonValue({ role: 'ADMIN', targetUserId: row.id }),
          newValue: toJsonValue({
            role: row.current_role,
            previousRole: 'ADMIN',
            targetUserId: row.id,
          }),
        });
      }
      return {
        dto: toDirectoryDto(row, row.current_role === 'ADMIN' ? 'ACTIVE_ADMIN' : 'ELIGIBLE'),
        changed,
      };
    });
    if (result.changed) {
      await this.sessions.deleteAllForUser(targetId);
    }
    return result.dto;
  }

  private async listDirectory(kind: 'admins' | 'eligible', rawQuery: Record<string, unknown>) {
    const query = parseCommandBody(superAdminDirectoryQuerySchema, rawQuery);
    const search = query.search?.trim() || null;
    const rows = await this.prisma.client.$queryRaw<DirectoryRow[]>`
      SELECT * FROM public.sgr_super_admin_directory(${kind}, ${search})
    `;
    return {
      items: rows.map((row) =>
        toDirectoryDto(row, kind === 'admins' ? 'ACTIVE_ADMIN' : 'ELIGIBLE'),
      ),
    };
  }
}

function parseUserId(userId: string): string {
  if (!UUID_RE.test(userId)) {
    throw new NotFoundException('Запись не найдена');
  }
  return userId;
}

async function queryGrant(
  tx: Prisma.TransactionClient,
  targetId: string,
  expectedVersion: number,
): Promise<GrantRow> {
  try {
    const rows = await tx.$queryRaw<GrantRow[]>`
      SELECT
        id,
        full_name,
        email,
        "current_role"::text AS current_role,
        previous_role::text AS previous_role,
        status::text AS status,
        archived_at,
        version
      FROM public.sgr_grant_admin(${targetId}::uuid, ${expectedVersion}::int)
    `;
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Запись не найдена');
    }
    return row;
  } catch (error) {
    mapAdminGrantError(error);
  }
}

async function queryRevoke(
  tx: Prisma.TransactionClient,
  targetId: string,
  expectedVersion: number,
): Promise<GrantRow> {
  try {
    const rows = await tx.$queryRaw<GrantRow[]>`
      SELECT
        id,
        full_name,
        email,
        "current_role"::text AS current_role,
        previous_role::text AS previous_role,
        status::text AS status,
        archived_at,
        version
      FROM public.sgr_revoke_admin(${targetId}::uuid, ${expectedVersion}::int)
    `;
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Запись не найдена');
    }
    return row;
  } catch (error) {
    mapAdminGrantError(error);
  }
}

function toDirectoryDto(
  row: DirectoryRow,
  adminStatus: SuperAdminDirectoryUser['adminStatus'],
): SuperAdminDirectoryUser {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    currentRole: row.current_role,
    roleLabel: roleLabel(row.current_role),
    adminStatus,
    status: row.status,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    version: row.version,
  };
}

function prismaRawMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'meta' in error) {
    const meta = (error as { meta?: { message?: unknown; code?: unknown } }).meta;
    if (meta && typeof meta.message === 'string') {
      return meta.message;
    }
  }
  return error instanceof Error ? error.message : '';
}

function mapAdminGrantError(error: unknown): never {
  if (
    error instanceof LastAdminRevokeError ||
    error instanceof AdminGrantNotEligibleError ||
    error instanceof StaleWriteError ||
    error instanceof NotFoundException ||
    error instanceof ForbiddenException
  ) {
    throw error;
  }
  const message = prismaRawMessage(error);
  if (message.includes('Нельзя снять права последнего администратора')) {
    throw new LastAdminRevokeError();
  }
  if (message.includes('Нельзя назначить эту учётную запись администратором')) {
    throw new AdminGrantNotEligibleError();
  }
  if (message.includes('Запись изменена другим пользователем')) {
    throw new StaleWriteError();
  }
  if (message.includes('Запись не найдена')) {
    throw new NotFoundException('Запись не найдена');
  }
  if (message.includes('Недостаточно прав')) {
    throw new ForbiddenException('Недостаточно прав');
  }
  throw error;
}
