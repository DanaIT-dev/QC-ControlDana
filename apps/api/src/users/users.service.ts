import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  createUserRequestSchema,
  historyQuerySchema,
  patchUserRequestSchema,
  usersListQuerySchema,
  versionedReasonSchema,
} from '@sgr-registry/contracts';
import {
  StaleWriteError,
  DuplicateValueError,
  AccountProtectedError,
  assertLastActiveAdminProtected,
  assertNotSelfArchive,
  normalizeUserEmail,
  normalizeUserFullName,
  roleLabel,
} from '@sgr-registry/domain';
import {
  reconcileDirectoryEngineerLinks,
  revokeEngineerObjectAccess,
  upsertUserCredentialsViaDefiner,
  type Prisma,
} from '@sgr-registry/database';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { generateTemporaryPassword } from '../auth/crypto';
import { Argon2PasswordHasher } from '../auth/password-hasher';
import { PrismaService } from '../auth/prisma.tokens';
import { RedisSessionStore } from '../auth/redis-session.store';
import { toJsonValue, writeAuditLog } from '../common/audit-writer';
import { isPrismaUniqueConflict, parseCommandBody } from '../common/command-body';
import { actorContext } from '../common/request-context';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyWhereAfter,
} from '../common/history-cursor';

const USER_SELECT = {
  id: true,
  fullName: true,
  email: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  lastLoginAt: true,
  mustChangePassword: true,
  version: true,
  archivedAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisSessionStore) private readonly sessions: RedisSessionStore,
    @Inject(Argon2PasswordHasher) private readonly hasher: Argon2PasswordHasher,
  ) {}

  async list(rawQuery: Record<string, unknown>) {
    const query = parseCommandBody(usersListQuerySchema, rawQuery);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where: Prisma.UserWhereInput = {
      role: { not: 'SUPER_ADMIN' },
    };
    if (query.role) {
      where.role = query.role;
    }
    if (query.status) {
      where.status = query.status;
    }
    if (query.search && query.search.trim().length >= 2) {
      const search = query.search.trim();
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search.toLowerCase(), mode: 'insensitive' } },
      ];
    }
    const totalCount = await this.prisma.client.user.count({ where });
    const items = await this.prisma.client.user.findMany({
      where,
      select: USER_SELECT,
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: items.map(toUserDto),
      page,
      pageSize,
      totalCount,
      totalPages: totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize),
    };
  }

  async create(actor: AuthenticatedUser, body: unknown, request: FastifyRequest) {
    const input = parseCommandBody(createUserRequestSchema, body);
    const fullName = normalizeUserFullName(input.fullName);
    const email = normalizeUserEmail(input.email);
    const temporaryPassword = generateTemporaryPassword(16, { email, fullName });
    const passwordHash = await this.hasher.hash(temporaryPassword, { email, fullName });
    const ctx = actorContext(actor, request);
    try {
      const user = await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            fullName,
            email,
            role: input.role,
            status: 'ACTIVE',
            mustChangePassword: true,
          },
          select: USER_SELECT,
        });
        await upsertUserCredentialsViaDefiner(tx, { userId: created.id, passwordHash });
        await writeAuditLog(tx, {
          ...ctx,
          action: 'USER_CREATED',
          entityType: 'USER',
          entityId: created.id,
          newValue: toJsonValue({
            fullName: created.fullName,
            email: created.email,
            role: created.role,
            mustChangePassword: true,
          }),
        });
        await syncDirectoryEngineerLinks(tx, actor, ctx.requestId, {
          userId: created.id,
          fullName: created.fullName,
          previousRole: created.role,
          nextRole: created.role,
          nextStatus: created.status,
        });
        return created;
      });
      return { user: toUserDto(user), temporaryPassword };
    } catch (error) {
      if (isPrismaUniqueConflict(error)) {
        throw new DuplicateValueError('Пользователь с такой почтой уже существует');
      }
      throw error;
    }
  }

  async update(actor: AuthenticatedUser, userId: string, body: unknown, request: FastifyRequest) {
    const input = parseCommandBody(patchUserRequestSchema, body);
    const ctx = actorContext(actor, request);
    const result = await this.prisma.client.$transaction(async (tx) => {
      const current = await tx.user.findUnique({ where: { id: userId }, select: USER_SELECT });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      assertOrdinaryStaffAccount(current.role);
      if (current.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const nextFullName = input.fullName
        ? normalizeUserFullName(input.fullName)
        : current.fullName;
      const nextRole = input.role ?? current.role;
      if (nextRole !== current.role) {
        const activeAdminCount = await tx.user.count({
          where: { role: 'ADMIN', status: 'ACTIVE' },
        });
        assertLastActiveAdminProtected({
          targetUserId: current.id,
          targetRole: current.role,
          nextRole,
          nextStatus: current.status,
          activeAdminCount,
        });
      }
      const invalidateSessions = nextRole !== current.role;
      const updated = await tx.user.updateMany({
        where: { id: userId, version: input.expectedVersion },
        data: {
          fullName: nextFullName,
          role: nextRole,
          version: { increment: 1 },
          ...(invalidateSessions ? { sessionVersion: { increment: 1 } } : {}),
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: USER_SELECT });
      const assignedFromPending = current.role === 'PENDING_ROLE' && nextRole !== current.role;
      await writeAuditLog(tx, {
        ...ctx,
        action: assignedFromPending ? 'USER_ROLE_ASSIGNED' : 'USER_UPDATED',
        entityType: 'USER',
        entityId: userId,
        oldValue: toJsonValue({
          fullName: current.fullName,
          role: current.role,
          targetUserId: userId,
          actorId: actor.id,
        }),
        newValue: toJsonValue({
          fullName: fresh.fullName,
          role: fresh.role,
          targetUserId: userId,
          actorId: actor.id,
        }),
      });
      await syncDirectoryEngineerLinks(tx, actor, ctx.requestId, {
        userId,
        fullName: fresh.fullName,
        previousRole: current.role,
        nextRole: fresh.role,
        nextStatus: fresh.status,
      });
      return { dto: toUserDto(fresh), invalidateSessions };
    });
    if (result.invalidateSessions) {
      await this.sessions.deleteAllForUser(userId);
    }
    return result.dto;
  }

  async archive(actor: AuthenticatedUser, userId: string, body: unknown, request: FastifyRequest) {
    const input = parseCommandBody(versionedReasonSchema, body);
    assertNotSelfArchive(actor.id, userId);
    const ctx = actorContext(actor, request);
    const archived = await this.prisma.client.$transaction(async (tx) => {
      const current = await tx.user.findUnique({ where: { id: userId }, select: USER_SELECT });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      assertOrdinaryStaffAccount(current.role);
      if (current.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      if (current.status === 'ARCHIVED') {
        return toUserDto(current);
      }
      const activeAdminCount = await tx.user.count({
        where: { role: 'ADMIN', status: 'ACTIVE' },
      });
      assertLastActiveAdminProtected({
        targetUserId: current.id,
        targetRole: current.role,
        nextStatus: 'ARCHIVED',
        activeAdminCount,
      });
      const now = new Date();
      const updated = await tx.user.updateMany({
        where: { id: userId, version: input.expectedVersion },
        data: {
          status: 'ARCHIVED',
          archivedAt: now,
          sessionVersion: { increment: 1 },
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: USER_SELECT });
      await writeAuditLog(tx, {
        ...ctx,
        action: 'USER_ARCHIVED',
        entityType: 'USER',
        entityId: userId,
        oldValue: toJsonValue({ status: current.status }),
        newValue: toJsonValue({ status: 'ARCHIVED' }),
        reason: input.reason ?? null,
      });
      await syncDirectoryEngineerLinks(tx, actor, ctx.requestId, {
        userId,
        fullName: fresh.fullName,
        previousRole: current.role,
        nextRole: current.role,
        nextStatus: 'ARCHIVED',
      });
      return toUserDto(fresh);
    });
    await this.sessions.deleteAllForUser(userId);
    return archived;
  }

  async restore(actor: AuthenticatedUser, userId: string, body: unknown, request: FastifyRequest) {
    const input = parseCommandBody(versionedReasonSchema, body);
    const ctx = actorContext(actor, request);
    return this.prisma.client.$transaction(async (tx) => {
      const current = await tx.user.findUnique({ where: { id: userId }, select: USER_SELECT });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      assertOrdinaryStaffAccount(current.role);
      if (current.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const updated = await tx.user.updateMany({
        where: { id: userId, version: input.expectedVersion },
        data: {
          status: 'ACTIVE',
          archivedAt: null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: USER_SELECT });
      await writeAuditLog(tx, {
        ...ctx,
        action: 'USER_RESTORED',
        entityType: 'USER',
        entityId: userId,
        oldValue: toJsonValue({ status: current.status }),
        newValue: toJsonValue({ status: 'ACTIVE' }),
        reason: input.reason ?? null,
      });
      await syncDirectoryEngineerLinks(tx, actor, ctx.requestId, {
        userId,
        fullName: fresh.fullName,
        previousRole: current.role,
        nextRole: current.role,
        nextStatus: 'ACTIVE',
      });
      return toUserDto(fresh);
    });
  }

  async resetPassword(
    actor: AuthenticatedUser,
    userId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(versionedReasonSchema, body);
    const preview = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    });
    if (!preview) {
      throw new NotFoundException('Запись не найдена');
    }
    assertOrdinaryStaffAccount(preview.role);
    const temporaryPassword = generateTemporaryPassword(16, {
      email: preview.email,
      fullName: preview.fullName,
    });
    const passwordHash = await this.hasher.hash(temporaryPassword, {
      email: preview.email,
      fullName: preview.fullName,
    });
    const ctx = actorContext(actor, request);
    const user = await this.prisma.client.$transaction(async (tx) => {
      const current = await tx.user.findUnique({ where: { id: userId }, select: USER_SELECT });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      assertOrdinaryStaffAccount(current.role);
      if (current.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const updated = await tx.user.updateMany({
        where: { id: userId, version: input.expectedVersion },
        data: {
          mustChangePassword: true,
          sessionVersion: { increment: 1 },
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: USER_SELECT });
      await upsertUserCredentialsViaDefiner(tx, { userId, passwordHash });
      await writeAuditLog(tx, {
        ...ctx,
        action: 'USER_PASSWORD_RESET',
        entityType: 'USER',
        entityId: userId,
        newValue: toJsonValue({ mustChangePassword: true, reset: true }),
      });
      return fresh;
    });
    await this.sessions.deleteAllForUser(userId);
    return { user: toUserDto(user), temporaryPassword };
  }

  async history(userId: string, rawQuery: Record<string, unknown>) {
    const exists = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!exists || exists.role === 'SUPER_ADMIN') {
      throw new NotFoundException('Запись не найдена');
    }
    const query = parseCommandBody(historyQuerySchema, rawQuery);
    const limit = query.limit ?? 50;
    const cursor = query.cursor ? decodeHistoryCursor(query.cursor) : null;
    const where: Prisma.AuditLogWhereInput = {
      entityType: 'USER',
      entityId: userId,
      ...(cursor ? historyWhereAfter(cursor) : {}),
    };
    const rows = await this.prisma.client.auditLog.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: historySelect,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map(toHistoryDto),
      nextCursor: hasMore ? encodeHistoryCursor(page[page.length - 1]!) : null,
    };
  }
}

function assertOrdinaryStaffAccount(role: AuthenticatedUser['role']): void {
  if (role === 'ADMIN' || role === 'SUPER_ADMIN' || role === 'UNASSIGNED') {
    throw new AccountProtectedError();
  }
}

async function syncDirectoryEngineerLinks(
  tx: Prisma.TransactionClient,
  actor: AuthenticatedUser,
  requestId: string | null,
  input: {
    userId: string;
    fullName: string;
    previousRole: AuthenticatedUser['role'];
    nextRole: AuthenticatedUser['role'];
    nextStatus: 'ACTIVE' | 'ARCHIVED';
  },
): Promise<void> {
  const ctx = {
    actorUserId: actor.id,
    actorName: actor.fullName,
    requestId,
    source: 'WEB' as const,
  };
  const lostEngineerAccess =
    input.previousRole === 'RESPONSIBLE_ENGINEER' &&
    (input.nextRole !== 'RESPONSIBLE_ENGINEER' || input.nextStatus !== 'ACTIVE');
  if (lostEngineerAccess) {
    await revokeEngineerObjectAccess(tx, { ...ctx, userId: input.userId });
  }
  const extraCandidates =
    input.nextRole === 'RESPONSIBLE_ENGINEER' && input.nextStatus === 'ACTIVE'
      ? [
          {
            id: input.userId,
            fullName: input.fullName,
            role: input.nextRole,
            status: input.nextStatus,
          },
        ]
      : [];
  await reconcileDirectoryEngineerLinks(tx, ctx, { extraCandidates });
}

function toUserDto(user: {
  id: string;
  fullName: string;
  email: string;
  role: AuthenticatedUser['role'];
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  mustChangePassword: boolean;
  version: number;
  archivedAt: Date | null;
}) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    roleLabel: roleLabel(user.role),
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    mustChangePassword: user.mustChangePassword,
    version: user.version,
    archivedAt: user.archivedAt?.toISOString() ?? null,
  };
}

const historySelect = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  parentEntityType: true,
  parentEntityId: true,
  oldValue: true,
  newValue: true,
  reason: true,
  actorUserId: true,
  actorName: true,
  occurredAt: true,
  requestId: true,
} as const;

function toHistoryDto(row: {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  parentEntityType: string | null;
  parentEntityId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  actorUserId: string | null;
  actorName: string | null;
  occurredAt: Date;
  requestId: string | null;
}) {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    parentEntityType: row.parentEntityType,
    parentEntityId: row.parentEntityId,
    oldValue: row.oldValue,
    newValue: row.newValue,
    reason: row.reason,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    occurredAt: row.occurredAt.toISOString(),
    requestId: row.requestId,
  };
}
