import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createUserRequestSchema,
  historyQuerySchema,
  patchUserProfileRequestSchema,
  patchUserRequestSchema,
  usersListQuerySchema,
  versionedReasonSchema,
} from '@sgr-registry/contracts';
import {
  StaleWriteError,
  DuplicateValueError,
  AccountProtectedError,
  DomainError,
  assertLastActiveAdminProtected,
  assertNotSelfArchive,
  assertCanAssignRole,
  assertCanEditUserProfile,
  assertCanMutateManagedUser,
  composeOfficialFullName,
  hasCapability,
  normalizeUserEmail,
  normalizeUserFullName,
  parsePersonNameInput,
  roleLabel,
  scrubSensitiveValue,
  ValidationError,
} from '@sgr-registry/domain';
import {
  reconcileDirectoryEngineerLinks,
  revokeEngineerObjectAccess,
  updateUserProfileViaDefiner,
  upsertUserCredentialsViaDefiner,
  type Prisma,
  type PrismaClient,
} from '@sgr-registry/database';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { generateTemporaryPassword } from '../auth/crypto';
import { Argon2PasswordHasher } from '../auth/password-hasher';
import { AUTH_PRISMA_CLIENT, PrismaService } from '../auth/prisma.tokens';
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

const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUTH_PRISMA_CLIENT) private readonly authPrisma: PrismaClient,
    @Inject(RedisSessionStore) private readonly sessions: RedisSessionStore,
    @Inject(Argon2PasswordHasher) private readonly hasher: Argon2PasswordHasher,
  ) {}

  async list(actor: AuthenticatedUser, rawQuery: Record<string, unknown>) {
    const query = parseCommandBody(usersListQuerySchema, rawQuery);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const filters: Prisma.UserWhereInput[] = [];
    if (!hasCapability(actor.role, 'VIEW_ALL_BUSINESS_DATA')) {
      filters.push({ role: { not: 'SUPER_ADMIN' } });
    }
    if (query.role) {
      filters.push({ role: query.role });
    }
    if (query.status) {
      filters.push({ status: query.status });
    }
    if (query.search && query.search.trim().length >= 2) {
      const search = query.search.trim();
      filters.push({
        OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search.toLowerCase(), mode: 'insensitive' } },
        ],
      });
    }
    const where: Prisma.UserWhereInput = filters.length > 0 ? { AND: filters } : {};
    const totalCount = await this.prisma.client.user.count({ where });
    const items = await this.prisma.client.user.findMany({
      where,
      select: USER_SELECT,
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const credentialFlags = await this.authPrisma.userCredential.findMany({
      where: { userId: { in: items.map((item) => item.id) } },
      select: { userId: true, passwordChangedAt: true },
    });
    const credentialsByUser = new Map(
      credentialFlags.map((row) => [row.userId, row.passwordChangedAt] as const),
    );
    let sessionCounts = new Map<string, number>();
    try {
      sessionCounts = await this.sessions.countForUsers(items.map((item) => item.id));
    } catch {
      sessionCounts = new Map();
    }
    return {
      items: items.map((item) =>
        toUserDto(item, {
          passwordConfigured: credentialsByUser.has(item.id),
          passwordChangedAt: credentialsByUser.get(item.id)?.toISOString() ?? null,
          activeSessionsCount: sessionCounts.get(item.id) ?? 0,
        }),
      ),
      page,
      pageSize,
      totalCount,
      totalPages: totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize),
    };
  }

  async create(actor: AuthenticatedUser, body: unknown, request: FastifyRequest) {
    const input = parseCommandBody(createUserRequestSchema, body);
    assertCanAssignRole(actor.role, input.role);
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
      throw mapUserMutationError(error);
    }
  }

  async update(actor: AuthenticatedUser, userId: string, body: unknown, request: FastifyRequest) {
    assertUserId(userId);
    const input = parseCommandBody(patchUserRequestSchema, body);
    const ctx = actorContext(actor, request);
    try {
      const result = await this.prisma.client.$transaction(async (tx) => {
        const current = await tx.user.findUnique({ where: { id: userId }, select: USER_SELECT });
        if (!current) {
          throw new NotFoundException('Запись не найдена');
        }
        assertCanMutateManagedUser(actor, current);
        if (current.version !== input.expectedVersion) {
          throw new StaleWriteError();
        }
        const nextRole = input.role ?? current.role;
        if (nextRole !== current.role) {
          assertCanAssignRole(actor.role, nextRole);
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
            role: nextRole,
            version: { increment: 1 },
            ...(invalidateSessions ? { sessionVersion: { increment: 1 } } : {}),
          },
        });
        if (updated.count !== 1) {
          throw new StaleWriteError();
        }
        const fresh = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: USER_SELECT,
        });
        if (nextRole !== current.role) {
          const assignedFromPending = current.role === 'PENDING_ROLE';
          await writeAuditLog(tx, {
            ...ctx,
            action: assignedFromPending ? 'USER_ROLE_ASSIGNED' : 'USER_ROLE_CHANGED',
            entityType: 'USER',
            entityId: userId,
            oldValue: toJsonValue({
              role: current.role,
              targetUserId: userId,
              actorId: actor.id,
            }),
            newValue: toJsonValue({
              role: fresh.role,
              targetUserId: userId,
              actorId: actor.id,
            }),
          });
          if (current.role !== 'MANAGER' && fresh.role === 'MANAGER') {
            await writeAuditLog(tx, {
              ...ctx,
              action: 'MANAGER_ROLE_GRANTED',
              entityType: 'USER',
              entityId: userId,
              oldValue: toJsonValue({
                role: current.role,
                targetUserId: userId,
                actorId: actor.id,
              }),
              newValue: toJsonValue({ role: fresh.role, targetUserId: userId, actorId: actor.id }),
            });
          }
          if (current.role === 'MANAGER' && fresh.role !== 'MANAGER') {
            await writeAuditLog(tx, {
              ...ctx,
              action: 'MANAGER_ROLE_REVOKED',
              entityType: 'USER',
              entityId: userId,
              oldValue: toJsonValue({
                role: current.role,
                targetUserId: userId,
                actorId: actor.id,
              }),
              newValue: toJsonValue({ role: fresh.role, targetUserId: userId, actorId: actor.id }),
            });
          }
        }
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
    } catch (error) {
      throw mapUserMutationError(error);
    }
  }

  async updateProfile(
    actor: AuthenticatedUser,
    userId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    assertUserId(userId);
    const input = parseCommandBody(patchUserProfileRequestSchema, body);
    const parts = parsePersonNameInput({
      lastName: input.lastName,
      firstName: input.firstName,
      middleName: input.middleName ?? null,
    });
    const fullName = composeOfficialFullName(parts);
    const email = normalizeUserEmail(input.email);
    const current = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    });
    if (!current) {
      throw new NotFoundException('Запись не найдена');
    }
    assertCanEditUserProfile(actor, current);
    const emailChanged = email !== current.email;
    if (emailChanged && actor.id === userId) {
      if (!input.currentPassword) {
        throw new ValidationError('currentPassword', 'Подтвердите текущий пароль');
      }
      const credentials = await this.authPrisma.userCredential.findUnique({
        where: { userId: actor.id },
        select: { passwordHash: true },
      });
      const matches = credentials?.passwordHash
        ? await this.hasher.verify(credentials.passwordHash, input.currentPassword)
        : false;
      if (!matches) {
        throw new UnauthorizedException('Неверный пароль');
      }
    }
    const ctx = actorContext(actor, request);
    const nameChanged = fullName !== current.fullName;
    let result: { dto: ReturnType<typeof toUserDto>; emailChanged: boolean };
    try {
      result = await this.prisma.client.$transaction(async (tx) => {
        const updated = await updateUserProfileViaDefiner(tx, {
          targetId: userId,
          lastName: parts.lastName,
          firstName: parts.firstName,
          middleName: parts.middleName,
          email,
          expectedVersion: input.expectedVersion,
          actorUserId: actor.id,
          actorName: actor.fullName,
          requestId: ctx.requestId,
        });
        const fresh = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: USER_SELECT,
        });
        if (nameChanged) {
          await syncDirectoryEngineerLinks(tx, actor, ctx.requestId, {
            userId,
            fullName: fresh.fullName,
            previousRole: fresh.role,
            nextRole: fresh.role,
            nextStatus: fresh.status,
          });
        }
        return { dto: toUserDto(fresh), emailChanged: updated.emailChanged };
      });
    } catch (error) {
      throw mapUserMutationError(error);
    }
    if (result.emailChanged) {
      try {
        await this.sessions.deleteAllForUser(userId);
      } catch (error) {
        this.logger.warn(
          `Failed to revoke Redis sessions after email change userId=${userId}: ${
            error instanceof Error ? error.message : 'unknown'
          }`,
        );
      }
    }
    return {
      user: result.dto,
      requireReauth: result.emailChanged && actor.id === userId,
    };
  }

  async archive(actor: AuthenticatedUser, userId: string, body: unknown, request: FastifyRequest) {
    assertUserId(userId);
    const input = parseCommandBody(versionedReasonSchema, body);
    assertNotSelfArchive(actor.id, userId);
    const ctx = actorContext(actor, request);
    const archived = await this.prisma.client.$transaction(async (tx) => {
      const current = await tx.user.findUnique({ where: { id: userId }, select: USER_SELECT });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      assertCanMutateManagedUser(actor, current);
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
    assertUserId(userId);
    const input = parseCommandBody(versionedReasonSchema, body);
    const ctx = actorContext(actor, request);
    return this.prisma.client.$transaction(async (tx) => {
      const current = await tx.user.findUnique({ where: { id: userId }, select: USER_SELECT });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      assertCanMutateManagedUser(actor, current);
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
    assertUserId(userId);
    const input = parseCommandBody(versionedReasonSchema, body);
    const preview = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    });
    if (!preview) {
      throw new NotFoundException('Запись не найдена');
    }
    assertCanMutateManagedUser(actor, preview);
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
      assertCanMutateManagedUser(actor, current);
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

  async history(actor: AuthenticatedUser, userId: string, rawQuery: Record<string, unknown>) {
    assertUserId(userId);
    const exists = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!exists) {
      throw new NotFoundException('Запись не найдена');
    }
    if (exists.role === 'SUPER_ADMIN' && !hasCapability(actor.role, 'VIEW_ALL_BUSINESS_DATA')) {
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

function assertUserId(userId: string): void {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new NotFoundException('Запись не найдена');
  }
}

function prismaRawMessage(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
  }
  if (error && typeof error === 'object' && 'code' in error) {
    parts.push(String((error as { code: unknown }).code));
  }
  if (error && typeof error === 'object' && 'meta' in error) {
    const meta = (error as { meta?: { message?: unknown; cause?: unknown; code?: unknown } }).meta;
    if (typeof meta?.message === 'string') {
      parts.push(meta.message);
    }
    if (typeof meta?.cause === 'string') {
      parts.push(meta.cause);
    }
    if (typeof meta?.code === 'string') {
      parts.push(meta.code);
    }
  }
  return parts.join('\n');
}

function mapUserMutationError(error: unknown): never {
  if (
    error instanceof DomainError ||
    error instanceof NotFoundException ||
    error instanceof UnauthorizedException
  ) {
    throw error;
  }
  const message = prismaRawMessage(error);
  if (/P0002|не найдена/i.test(message)) {
    throw new NotFoundException('Запись не найдена');
  }
  if (/40001|изменена другим/i.test(message)) {
    throw new StaleWriteError();
  }
  if (/23505|P2002|уже существует/i.test(message)) {
    throw new DuplicateValueError('Пользователь с такой почтой уже существует');
  }
  if (/42501|Недостаточно прав/i.test(message)) {
    throw new AccountProtectedError();
  }
  if (/22023|обязательн/i.test(message)) {
    throw new ValidationError('lastName', 'Значение обязательно');
  }
  if (/Некорректный адрес/i.test(message)) {
    throw new ValidationError('email', 'Некорректный адрес электронной почты');
  }
  if (/Недопустимые символы/i.test(message)) {
    throw new ValidationError('lastName', 'Недопустимые символы');
  }
  throw error instanceof Error ? error : new Error(String(error));
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

function toUserDto(
  user: {
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
  },
  extras?: {
    passwordConfigured?: boolean;
    passwordChangedAt?: string | null;
    activeSessionsCount?: number;
  },
) {
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
    ...(extras?.passwordConfigured !== undefined
      ? { passwordConfigured: extras.passwordConfigured }
      : {}),
    ...(extras && 'passwordChangedAt' in extras
      ? { passwordChangedAt: extras.passwordChangedAt ?? null }
      : {}),
    ...(extras?.activeSessionsCount !== undefined
      ? { activeSessionsCount: extras.activeSessionsCount }
      : {}),
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
    oldValue: scrubSensitiveValue(row.oldValue),
    newValue: scrubSensitiveValue(row.newValue),
    reason: row.reason,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    occurredAt: row.occurredAt.toISOString(),
    requestId: row.requestId,
  };
}
