import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  completeOwnProfileRequestSchema,
  createUserRequestSchema,
  historyQuerySchema,
  assignOrganizationMembershipRequestSchema,
  patchUserEmploymentRequestSchema,
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
  canEditEmployment,
  canViewEmployees,
  composeOfficialFullName,
  comparePersonNames,
  hasCapability,
  normalizeUserEmail,
  parsePersonNameInput,
  personMatchesSearch,
  roleLabel,
  scrubSensitiveValue,
  ValidationError,
} from '@sgr-registry/domain';
import {
  completeOwnProfileViaDefiner,
  reconcileDirectoryEngineerLinks,
  reconcileImportedEngineerReferences,
  revokeEngineerObjectAccess,
  updateUserEmploymentViaDefiner,
  updateUserProfileViaDefiner,
  upsertUserCredentialsViaDefiner,
  type Prisma,
  type PrismaClient,
} from '@sgr-registry/database';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { generateTemporaryPassword } from '../auth/crypto.js';
import { Argon2PasswordHasher } from '../auth/password-hasher.js';
import { AUTH_PRISMA_CLIENT, PrismaService } from '../auth/prisma.tokens.js';
import { RedisSessionStore } from '../auth/redis-session.store.js';
import { loadActorNamePartsByUserId } from '../common/actor-name-parts.js';
import { toJsonValue, writeAuditLog } from '../common/audit-writer.js';
import { isPrismaUniqueConflict, parseCommandBody } from '../common/command-body.js';
import { actorContext } from '../common/request-context.js';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyWhereAfter,
} from '../common/history-cursor.js';

const USER_SELECT = {
  id: true,
  lastName: true,
  firstName: true,
  middleName: true,
  fullName: true,
  email: true,
  phone: true,
  birthDate: true,
  hiredOn: true,
  contractEndsOn: true,
  mustCompleteProfile: true,
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
    if (!canViewEmployees(actor.role)) {
      throw new ForbiddenException('Недостаточно прав');
    }
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
      const candidates = await this.prisma.client.user.findMany({
        where: filters.length > 0 ? { AND: filters } : {},
        select: {
          id: true,
          lastName: true,
          firstName: true,
          middleName: true,
          fullName: true,
          email: true,
        },
      });
      const matchingIds = candidates
        .filter(
          (item) =>
            personMatchesSearch(item.fullName, search) ||
            item.email.toLowerCase().includes(search.toLowerCase()),
        )
        .map((item) => item.id);
      filters.push({
        id: {
          in: matchingIds.length > 0 ? matchingIds : ['00000000-0000-4000-8000-000000000000'],
        },
      });
    }
    const where: Prisma.UserWhereInput = filters.length > 0 ? { AND: filters } : {};
    const totalCount = await this.prisma.client.user.count({ where });
    const ranked = await this.prisma.client.user.findMany({
      where,
      select: { id: true, lastName: true, firstName: true, middleName: true },
    });
    ranked.sort((left, right) => {
      const byName = comparePersonNames(
        {
          lastName: left.lastName,
          firstName: left.firstName,
          middleName: left.middleName,
        },
        {
          lastName: right.lastName,
          firstName: right.firstName,
          middleName: right.middleName,
        },
      );
      return byName !== 0 ? byName : left.id.localeCompare(right.id);
    });
    const pageIds = ranked.slice((page - 1) * pageSize, page * pageSize).map((row) => row.id);
    const itemsUnsorted =
      pageIds.length === 0
        ? []
        : await this.prisma.client.user.findMany({
            where: { id: { in: pageIds } },
            select: USER_SELECT,
          });
    const itemsById = new Map(itemsUnsorted.map((item) => [item.id, item]));
    const items = pageIds
      .map((id) => itemsById.get(id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
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
    const parts = parsePersonNameInput({
      lastName: input.lastName,
      firstName: input.firstName,
      middleName: input.middleName ?? null,
    });
    const fullName = composeOfficialFullName(parts);
    const email = normalizeUserEmail(input.email);
    const temporaryPassword = generateTemporaryPassword(16, { email, fullName });
    const passwordHash = await this.hasher.hash(temporaryPassword, { email, fullName });
    const ctx = actorContext(actor, request);
    try {
      const user = await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            lastName: parts.lastName,
            firstName: parts.firstName,
            middleName: parts.middleName,
            fullName,
            email,
            role: input.role,
            status: 'ACTIVE',
            mustChangePassword: true,
            mustCompleteProfile: true,
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
            mustCompleteProfile: true,
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

  async completeOwnProfile(actor: AuthenticatedUser, body: unknown, request: FastifyRequest) {
    if (!actor.mustCompleteProfile) {
      throw new ForbiddenException('Карточка уже заполнена');
    }
    const input = parseCommandBody(completeOwnProfileRequestSchema, body);
    const parts = parsePersonNameInput({
      lastName: input.lastName,
      firstName: input.firstName,
      middleName: input.middleName ?? null,
    });
    const fullName = composeOfficialFullName(parts);
    const phone = normalizeEmployeePhone(input.phone);
    assertBirthDate(input.birthDate);
    const ctx = actorContext(actor, request);
    try {
      const fresh = await this.prisma.client.$transaction(async (tx) => {
        const updated = await completeOwnProfileViaDefiner(tx, {
          lastName: parts.lastName,
          firstName: parts.firstName,
          middleName: parts.middleName,
          fullName,
          phone,
          birthDate: input.birthDate,
        });
        const saved = await tx.user.findUniqueOrThrow({
          where: { id: updated.id },
          select: USER_SELECT,
        });
        if (fullName !== actor.fullName) {
          await syncDirectoryEngineerLinks(tx, actor, ctx.requestId, {
            userId: saved.id,
            fullName: saved.fullName,
            previousRole: saved.role,
            nextRole: saved.role,
            nextStatus: saved.status,
          });
        }
        await writeAuditLog(tx, {
          ...ctx,
          action: 'USER_CARD_COMPLETED',
          entityType: 'USER',
          entityId: saved.id,
          newValue: toJsonValue({
            phoneSet: true,
            birthDateSet: true,
            mustCompleteProfile: false,
          }),
        });
        return saved;
      });
      return { user: toUserDto(fresh) };
    } catch (error) {
      throw mapUserMutationError(error);
    }
  }

  async updateEmployment(
    actor: AuthenticatedUser,
    userId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    assertUserId(userId);
    if (!canEditEmployment(actor.role)) {
      throw new AccountProtectedError();
    }
    const input = parseCommandBody(patchUserEmploymentRequestSchema, body);
    if (input.hiredOn) {
      assertHireDate(input.hiredOn);
    }
    if (input.contractEndsOn) {
      assertContractEndDate(input.contractEndsOn, input.hiredOn);
    }
    const ctx = actorContext(actor, request);
    try {
      const fresh = await this.prisma.client.$transaction(async (tx) => {
        const current = await tx.user.findUnique({ where: { id: userId }, select: USER_SELECT });
        if (!current) {
          throw new NotFoundException('Запись не найдена');
        }
        await updateUserEmploymentViaDefiner(tx, {
          targetId: userId,
          hiredOn: input.hiredOn,
          contractEndsOn: input.contractEndsOn,
          expectedVersion: input.expectedVersion,
        });
        const saved = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: USER_SELECT,
        });
        await writeAuditLog(tx, {
          ...ctx,
          action: 'USER_EMPLOYMENT_UPDATED',
          entityType: 'USER',
          entityId: userId,
          oldValue: toJsonValue({
            hiredOn: calendarDate(current.hiredOn),
            contractEndsOn: calendarDate(current.contractEndsOn),
          }),
          newValue: toJsonValue({
            hiredOn: calendarDate(saved.hiredOn),
            contractEndsOn: calendarDate(saved.contractEndsOn),
          }),
        });
        return saved;
      });
      return { user: toUserDto(fresh) };
    } catch (error) {
      throw mapUserMutationError(error);
    }
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
    const actorParts = await loadActorNamePartsByUserId(
      this.prisma.client,
      page.map((row) => row.actorUserId),
    );
    return {
      items: page.map((row) =>
        toHistoryDto(row, row.actorUserId ? actorParts.get(row.actorUserId) : undefined),
      ),
      nextCursor: hasMore ? encodeHistoryCursor(page[page.length - 1]!) : null,
    };
  }
  async listOrganizationMemberships(actor: AuthenticatedUser, userId: string) {
    assertUserId(userId);
    const target = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!target) {
      throw new NotFoundException('Запись не найдена');
    }
    const memberships = await this.prisma.client.userOrganizationMembership.findMany({
      where: { userId },
      orderBy: [{ revokedAt: 'asc' }, { assignedAt: 'desc' }],
      select: {
        id: true,
        organizationId: true,
        assignedAt: true,
        revokedAt: true,
        organization: { select: { officialName: true } },
      },
    });
    const canAssign = hasCapability(actor.role, 'MANAGE_USERS');
    const organizations = canAssign
      ? await this.prisma.client.organization.findMany({
          where: { active: true, roles: { some: { role: 'LIABLE_CONTRACTOR' } } },
          select: { id: true, officialName: true },
          orderBy: { officialName: 'asc' },
        })
      : [];
    return {
      canAssign,
      memberships: memberships.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        organizationName: row.organization.officialName,
        assignedAt: row.assignedAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
        active: row.revokedAt == null,
      })),
      organizations: organizations.map((row) => ({ id: row.id, name: row.officialName })),
    };
  }

  async assignOrganizationMembership(
    actor: AuthenticatedUser,
    userId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    if (!hasCapability(actor.role, 'MANAGE_USERS')) {
      throw new NotFoundException('Запись не найдена');
    }
    const input = parseCommandBody(assignOrganizationMembershipRequestSchema, body);
    assertUserId(userId);
    const ctx = actorContext(actor, request);
    return this.prisma.client.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!target) {
        throw new NotFoundException('Запись не найдена');
      }
      const organization = await tx.organization.findUnique({
        where: { id: input.organizationId },
        select: { id: true, active: true },
      });
      if (!organization?.active) {
        throw new ValidationError('organizationId', 'Можно назначить только активную организацию');
      }
      const existing = await tx.userOrganizationMembership.findFirst({
        where: { userId, organizationId: input.organizationId, revokedAt: null },
      });
      if (existing) {
        return { id: existing.id, active: true };
      }
      const created = await tx.userOrganizationMembership.create({
        data: {
          userId,
          organizationId: input.organizationId,
          assignedByUserId: actor.id,
        },
      });
      await writeAuditLog(tx, {
        ...ctx,
        action: 'USER_ORGANIZATION_MEMBERSHIP_GRANTED',
        entityType: 'USER',
        entityId: userId,
        newValue: toJsonValue({
          membershipId: created.id,
          organizationId: input.organizationId,
        }),
      });
      return { id: created.id, active: true };
    });
  }

  async revokeOrganizationMembership(
    actor: AuthenticatedUser,
    userId: string,
    membershipId: string,
    request: FastifyRequest,
  ) {
    if (!hasCapability(actor.role, 'MANAGE_USERS')) {
      throw new NotFoundException('Запись не найдена');
    }
    assertUserId(userId);
    assertUserId(membershipId);
    const ctx = actorContext(actor, request);
    return this.prisma.client.$transaction(async (tx) => {
      const current = await tx.userOrganizationMembership.findFirst({
        where: { id: membershipId, userId },
      });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      if (current.revokedAt) {
        return { id: current.id, active: false };
      }
      await tx.userOrganizationMembership.update({
        where: { id: current.id },
        data: {
          revokedAt: new Date(),
          revokedByUserId: actor.id,
          version: { increment: 1 },
        },
      });
      await writeAuditLog(tx, {
        ...ctx,
        action: 'USER_ORGANIZATION_MEMBERSHIP_REVOKED',
        entityType: 'USER',
        entityId: userId,
        oldValue: toJsonValue({
          membershipId: current.id,
          organizationId: current.organizationId,
          active: true,
        }),
        newValue: toJsonValue({
          membershipId: current.id,
          organizationId: current.organizationId,
          active: false,
        }),
      });
      return { id: current.id, active: false };
    });
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
  if (input.nextRole === 'RESPONSIBLE_ENGINEER' && input.nextStatus === 'ACTIVE') {
    await reconcileImportedEngineerReferences(tx, {
      actorUserId: actor.id,
      actorName: actor.fullName,
      requestId,
      source: 'WEB',
      targetUserId: input.userId,
    });
  }
}

function calendarDate(value: Date | null): string | null {
  if (!value) {
    return null;
  }
  return value.toISOString().slice(0, 10);
}

function todayInMinsk(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addCalendarDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function assertBirthDate(value: string): void {
  if (value < '1900-01-01' || value > todayInMinsk()) {
    throw new ValidationError('birthDate', 'Укажите дату рождения');
  }
}

function assertHireDate(value: string): void {
  if (value < '1950-01-01' || value > addCalendarDays(todayInMinsk(), 366)) {
    throw new ValidationError('hiredOn', 'Укажите дату приёма на работу');
  }
}

function assertContractEndDate(value: string, hiredOn: string | null): void {
  if (value < '1950-01-01' || value > '2100-12-31') {
    throw new ValidationError('contractEndsOn', 'Укажите дату окончания контракта');
  }
  if (hiredOn && value < hiredOn) {
    throw new ValidationError('contractEndsOn', 'Контракт не может закончиться раньше приёма');
  }
}

function normalizeEmployeePhone(value: string): string {
  const phone = value.trim().replace(/\s+/g, ' ');
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15 || phone.length > 32) {
    throw new ValidationError('phone', 'Укажите номер телефона');
  }
  return phone;
}

function toUserDto(
  user: {
    id: string;
    lastName: string;
    firstName: string;
    middleName: string | null;
    fullName: string;
    email: string;
    phone: string | null;
    birthDate: Date | null;
    hiredOn: Date | null;
    contractEndsOn: Date | null;
    mustCompleteProfile: boolean;
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
    lastName: user.lastName,
    firstName: user.firstName,
    middleName: user.middleName,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    birthDate: calendarDate(user.birthDate),
    hiredOn: calendarDate(user.hiredOn),
    contractEndsOn: calendarDate(user.contractEndsOn),
    mustCompleteProfile: user.mustCompleteProfile,
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

function toHistoryDto(
  row: {
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
  },
  parts?: { lastName: string; firstName: string; middleName: string | null },
) {
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
    actorLastName: parts?.lastName ?? null,
    actorFirstName: parts?.firstName ?? null,
    actorMiddleName: parts?.middleName ?? null,
    occurredAt: row.occurredAt.toISOString(),
    requestId: row.requestId,
  };
}
