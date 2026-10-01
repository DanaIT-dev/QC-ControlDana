import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  type SafeUserProfile,
} from '@sgr-registry/contracts';
import {
  AUTH_LOGIN_FAILED_MESSAGE,
  AUTH_RATE_LIMITED_MESSAGE,
  capabilitiesForRole,
  CAPABILITY_LABELS,
  isValidEmail,
  normalizeEmail,
  roleLabel,
  type AuthAuditAction,
  assertPasswordPolicy,
  isSessionExpired,
  redisSessionTtlSeconds,
  sessionAbsoluteExpiresAt,
} from '@sgr-registry/domain';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from './authenticated-user.js';
import { generateOpaqueToken, hashSessionId } from './crypto.js';
import { Argon2PasswordHasher } from './password-hasher.js';
import { AUTH_PRISMA_CLIENT } from './prisma.tokens.js';
import type { PrismaClient } from '@sgr-registry/database';
import { RedisUnavailableError } from './redis.constants.js';
import { clientIp } from './request-meta.js';
import { isLoginRateLimited, RedisSessionStore } from './redis-session.store.js';
import type { StoredSession } from './session-store.js';
import { toJsonValue } from '../common/audit-writer.js';

const DUMMY_PASSWORD_MATERIAL = 'sgr-dummy-verify-material-not-a-user-password';

@Injectable()
export class AuthService {
  private dummyHashPromise: Promise<string> | undefined;

  constructor(
    @Inject(AUTH_PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(RedisSessionStore) private readonly sessions: RedisSessionStore,
    @Inject(Argon2PasswordHasher) private readonly hasher: Argon2PasswordHasher,
  ) {}

  async login(
    body: unknown,
    request: FastifyRequest,
  ): Promise<{ profile: SafeUserProfile; sessionId: string }> {
    const parsed = loginRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Некорректные данные входа');
    }

    const email = normalizeEmail(parsed.data.email);
    const password = parsed.data.password;
    const config = loadConfig();
    const ip = clientIp(request, config.TRUST_PROXY);
    const requestId = requestIdOf(request);

    if (!isValidEmail(email)) {
      await this.recordFailedLogin({
        email,
        ip,
        requestId,
        actorUserId: null,
        entityId: 'unknown',
      });
      throw invalidCredentials();
    }

    try {
      const failures = await this.sessions.peekLoginFailures(email, ip);
      if (
        isLoginRateLimited(
          failures.emailCount,
          failures.ipCount,
          config.AUTH_LOGIN_MAX_FAILURES,
          config.AUTH_LOGIN_IP_MAX_FAILURES,
        )
      ) {
        await this.writeAudit({
          actorUserId: null,
          action: 'LOGIN_RATE_LIMITED',
          entityType: 'USER',
          entityId: 'unknown',
          ipAddress: ip,
          requestId,
          newValue: { email },
        });
        throw new HttpException(AUTH_RATE_LIMITED_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw unavailableOrRethrow(error);
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { credentials: { select: { passwordHash: true } } },
    });
    const dummyHash = await this.getDummyHash();
    const storedHash = user?.credentials?.passwordHash;

    if (!user || !storedHash || user.status === 'ARCHIVED') {
      await this.hasher.verify(dummyHash, password);
      await this.recordFailedLogin({
        email,
        ip,
        requestId,
        actorUserId: null,
        entityId: user?.id ?? 'unknown',
      });
      throw invalidCredentials();
    }

    const passwordMatches = await this.hasher.verify(storedHash, password);
    if (!passwordMatches) {
      await this.recordFailedLogin({
        email,
        ip,
        requestId,
        actorUserId: user.id,
        entityId: user.id,
      });
      throw invalidCredentials();
    }

    try {
      await this.sessions.resetLoginFailures(email, ip);
    } catch (error) {
      throw unavailableOrRethrow(error);
    }

    const sessionId = generateOpaqueToken(32);
    const sessionHash = hashSessionId(sessionId);
    const csrfToken = generateOpaqueToken(32);
    const now = new Date();
    const { session, ttlSeconds } = buildStoredSession({
      userId: user.id,
      sessionVersion: user.sessionVersion,
      csrfToken,
      now,
      createdAt: now,
      lastActivityAt: now,
      idleTimeoutSeconds: config.SESSION_IDLE_TIMEOUT_SECONDS,
      absoluteLifetimeSeconds: config.SESSION_ABSOLUTE_LIFETIME_SECONDS,
    });

    try {
      await this.sessions.save(sessionHash, user.id, session, ttlSeconds);
    } catch (error) {
      throw unavailableOrRethrow(error);
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: now },
    });

    await this.writeAudit({
      actorUserId: user.id,
      action: 'LOGIN_SUCCEEDED',
      entityType: 'USER',
      entityId: user.id,
      ipAddress: ip,
      requestId,
      newValue: { email: user.email },
    });

    return {
      sessionId,
      profile: toSafeProfile(user, csrfToken),
    };
  }

  async resolveSession(sessionId: string, request: FastifyRequest): Promise<AuthenticatedUser> {
    const sessionHash = hashSessionId(sessionId);
    let stored: StoredSession | null;
    try {
      stored = await this.sessions.get(sessionHash);
    } catch (error) {
      if (error instanceof RedisUnavailableError) {
        throw new UnauthorizedException('Требуется авторизация');
      }
      throw error;
    }

    if (!stored) {
      throw new UnauthorizedException('Требуется авторизация');
    }

    const config = loadConfig();
    const now = new Date();
    if (!hasSessionLifetimeFields(stored) || isStoredSessionExpired(stored, now, config)) {
      try {
        await this.sessions.delete(sessionHash, stored.userId);
      } catch {
        // Session is already unusable; fail closed without leaking store errors.
      }
      throw new UnauthorizedException('Требуется авторизация');
    }

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId } });
    const ip = clientIp(request, config.TRUST_PROXY);
    const requestId = requestIdOf(request);

    if (!user) {
      try {
        await this.sessions.delete(sessionHash, stored.userId);
      } catch {
        // ignore
      }
      throw new UnauthorizedException('Требуется авторизация');
    }

    if (user.status === 'ARCHIVED') {
      await this.writeAudit({
        actorUserId: user.id,
        action: 'SESSION_REJECTED_ARCHIVED_USER',
        entityType: 'SESSION',
        entityId: user.id,
        ipAddress: ip,
        requestId,
      });
      try {
        await this.sessions.deleteAllForUser(user.id);
      } catch {
        // User remains unauthorized even if cleanup fails.
      }
      throw new UnauthorizedException('Требуется авторизация');
    }

    if (user.sessionVersion !== stored.sessionVersion) {
      await this.writeAudit({
        actorUserId: user.id,
        action: 'SESSION_REJECTED_VERSION_MISMATCH',
        entityType: 'SESSION',
        entityId: user.id,
        ipAddress: ip,
        requestId,
      });
      try {
        await this.sessions.delete(sessionHash, user.id);
      } catch {
        // ignore
      }
      throw new UnauthorizedException('Требуется авторизация');
    }

    const touched = touchStoredSession(stored, now, config);
    try {
      await this.sessions.save(sessionHash, user.id, touched.session, touched.ttlSeconds);
    } catch (error) {
      if (error instanceof RedisUnavailableError) {
        throw new UnauthorizedException('Требуется авторизация');
      }
      throw error;
    }

    return {
      id: user.id,
      lastName: user.lastName,
      firstName: user.firstName,
      middleName: user.middleName,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      sessionVersion: user.sessionVersion,
      sessionHash,
      csrfToken: stored.csrfToken,
      mustChangePassword: user.mustChangePassword,
    };
  }

  me(user: AuthenticatedUser): SafeUserProfile {
    return toSafeProfile(user, user.csrfToken);
  }

  capabilities(user: AuthenticatedUser) {
    const capabilities = capabilitiesForRole(user.role);
    return {
      role: user.role,
      roleLabel: roleLabel(user.role),
      capabilities,
      capabilityLabels: Object.fromEntries(
        capabilities.map((capability) => [capability, CAPABILITY_LABELS[capability]]),
      ),
    };
  }

  async changePassword(
    user: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{ profile: SafeUserProfile; sessionId: string }> {
    const parsed = changePasswordRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Некорректные данные');
    }
    const stored = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: { credentials: { select: { passwordHash: true } } },
    });
    if (!stored?.credentials?.passwordHash) {
      throw new UnauthorizedException('Требуется авторизация');
    }
    const matches = await this.hasher.verify(
      stored.credentials.passwordHash,
      parsed.data.currentPassword,
    );
    if (!matches) {
      throw new BadRequestException('Неверный текущий пароль');
    }
    assertPasswordPolicy(parsed.data.newPassword, {
      email: stored.email,
      fullName: stored.fullName,
    });
    const passwordHash = await this.hasher.hash(parsed.data.newPassword, {
      email: stored.email,
      fullName: stored.fullName,
    });
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.userCredential.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          passwordHash,
          passwordChangedAt: new Date(),
        },
        update: {
          passwordHash,
          passwordChangedAt: new Date(),
        },
      });
      return tx.user.update({
        where: { id: user.id },
        data: {
          mustChangePassword: false,
          sessionVersion: { increment: 1 },
          version: { increment: 1 },
        },
      });
    });
    try {
      await this.sessions.deleteAllForUser(user.id);
    } catch (error) {
      throw unavailableOrRethrow(error);
    }
    const sessionId = generateOpaqueToken(32);
    const sessionHash = hashSessionId(sessionId);
    const csrfToken = generateOpaqueToken(32);
    const now = new Date();
    const config = loadConfig();
    const { session, ttlSeconds } = buildStoredSession({
      userId: user.id,
      sessionVersion: updated.sessionVersion,
      csrfToken,
      now,
      createdAt: now,
      lastActivityAt: now,
      idleTimeoutSeconds: config.SESSION_IDLE_TIMEOUT_SECONDS,
      absoluteLifetimeSeconds: config.SESSION_ABSOLUTE_LIFETIME_SECONDS,
    });
    try {
      await this.sessions.save(sessionHash, user.id, session, ttlSeconds);
    } catch (error) {
      throw unavailableOrRethrow(error);
    }
    await this.writeAudit({
      actorUserId: user.id,
      action: 'USER_PASSWORD_CHANGED',
      entityType: 'USER',
      entityId: user.id,
      ipAddress: clientIp(request, config.TRUST_PROXY),
      requestId: requestIdOf(request),
      newValue: { mustChangePassword: false },
    });
    return { sessionId, profile: toSafeProfile(updated, csrfToken) };
  }

  async logout(user: AuthenticatedUser, request: FastifyRequest): Promise<void> {
    const config = loadConfig();
    try {
      await this.sessions.delete(user.sessionHash, user.id);
    } catch (error) {
      if (error instanceof RedisUnavailableError) {
        throw new UnauthorizedException('Требуется авторизация');
      }
      throw error;
    }

    await this.writeAudit({
      actorUserId: user.id,
      action: 'LOGOUT',
      entityType: 'SESSION',
      entityId: user.id,
      ipAddress: clientIp(request, config.TRUST_PROXY),
      requestId: requestIdOf(request),
    });
  }

  async logoutAll(user: AuthenticatedUser, request: FastifyRequest): Promise<void> {
    const config = loadConfig();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 } },
    });

    try {
      await this.sessions.deleteAllForUser(user.id);
    } catch (error) {
      if (error instanceof RedisUnavailableError) {
        throw new UnauthorizedException('Требуется авторизация');
      }
      throw error;
    }

    await this.writeAudit({
      actorUserId: user.id,
      action: 'LOGOUT_ALL',
      entityType: 'SESSION',
      entityId: user.id,
      ipAddress: clientIp(request, config.TRUST_PROXY),
      requestId: requestIdOf(request),
    });
  }

  private async getDummyHash(): Promise<string> {
    this.dummyHashPromise ??= this.hasher.hashUnchecked(DUMMY_PASSWORD_MATERIAL);
    return this.dummyHashPromise;
  }

  private async recordFailedLogin(input: {
    email: string;
    ip: string;
    requestId: string | null;
    actorUserId: string | null;
    entityId: string;
  }): Promise<void> {
    const config = loadConfig();
    try {
      await this.sessions.incrementLoginFailures(
        input.email,
        input.ip,
        config.AUTH_LOGIN_MAX_FAILURES,
        config.AUTH_LOGIN_IP_MAX_FAILURES,
        config.AUTH_LOGIN_WINDOW_SECONDS,
      );
    } catch (error) {
      throw unavailableOrRethrow(error);
    }

    await this.writeAudit({
      actorUserId: input.actorUserId,
      action: 'LOGIN_FAILED',
      entityType: 'USER',
      entityId: input.entityId,
      ipAddress: input.ip,
      requestId: input.requestId,
      newValue: { email: input.email },
    });
  }

  private async writeAudit(input: {
    actorUserId: string | null;
    action: AuthAuditAction;
    entityType: 'USER' | 'SESSION';
    entityId: string;
    ipAddress: string | null;
    requestId: string | null;
    newValue?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        newValue: input.newValue ? toJsonValue(input.newValue) : undefined,
        ipAddress: input.ipAddress,
        requestId: input.requestId,
        occurredAt: new Date(),
      },
    });
  }
}

export function toSafeProfile(
  user: {
    id: string;
    lastName?: string;
    firstName?: string;
    middleName?: string | null;
    fullName: string;
    email: string;
    role: SafeUserProfile['role'];
    mustChangePassword?: boolean;
  },
  csrfToken: string,
): SafeUserProfile {
  return {
    id: user.id,
    lastName: user.lastName,
    firstName: user.firstName,
    middleName: user.middleName,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    roleLabel: roleLabel(user.role),
    csrfToken,
    mustChangePassword: Boolean(user.mustChangePassword),
  };
}

function invalidCredentials(): UnauthorizedException {
  return new UnauthorizedException(AUTH_LOGIN_FAILED_MESSAGE);
}

function requestIdOf(request: FastifyRequest): string | null {
  const fromRequest = (request as FastifyRequest & { requestId?: string }).requestId;
  if (typeof fromRequest === 'string' && fromRequest.length > 0) {
    return fromRequest;
  }
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && header.length > 0 ? header : null;
}

function unavailableOrRethrow(error: unknown): never {
  if (error instanceof RedisUnavailableError) {
    throw new HttpException('Сервис временно недоступен', HttpStatus.SERVICE_UNAVAILABLE);
  }
  throw error;
}

function hasSessionLifetimeFields(
  session: StoredSession,
): session is StoredSession & { lastActivityAt: string; absoluteExpiresAt: string } {
  return (
    typeof session.lastActivityAt === 'string' &&
    session.lastActivityAt.length > 0 &&
    typeof session.absoluteExpiresAt === 'string' &&
    session.absoluteExpiresAt.length > 0 &&
    typeof session.createdAt === 'string' &&
    session.createdAt.length > 0
  );
}

function lifetimeFromConfig(config: {
  SESSION_IDLE_TIMEOUT_SECONDS: number;
  SESSION_ABSOLUTE_LIFETIME_SECONDS: number;
}): Pick<
  Parameters<typeof redisSessionTtlSeconds>[0],
  'idleTimeoutSeconds' | 'absoluteLifetimeSeconds'
> {
  return {
    idleTimeoutSeconds: config.SESSION_IDLE_TIMEOUT_SECONDS,
    absoluteLifetimeSeconds: config.SESSION_ABSOLUTE_LIFETIME_SECONDS,
  };
}

function isStoredSessionExpired(
  session: StoredSession,
  now: Date,
  config: {
    SESSION_IDLE_TIMEOUT_SECONDS: number;
    SESSION_ABSOLUTE_LIFETIME_SECONDS: number;
  },
): boolean {
  const createdAtMs = Date.parse(session.createdAt);
  const lastActivityAtMs = Date.parse(session.lastActivityAt);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(lastActivityAtMs)) {
    return true;
  }
  return isSessionExpired({
    createdAtMs,
    lastActivityAtMs,
    nowMs: now.getTime(),
    ...lifetimeFromConfig(config),
  });
}

function buildStoredSession(input: {
  userId: string;
  sessionVersion: number;
  csrfToken: string;
  now: Date;
  createdAt: Date;
  lastActivityAt: Date;
  idleTimeoutSeconds: number;
  absoluteLifetimeSeconds: number;
}): { session: StoredSession; ttlSeconds: number } {
  const ttlSeconds = redisSessionTtlSeconds({
    createdAtMs: input.createdAt.getTime(),
    lastActivityAtMs: input.lastActivityAt.getTime(),
    nowMs: input.now.getTime(),
    idleTimeoutSeconds: input.idleTimeoutSeconds,
    absoluteLifetimeSeconds: input.absoluteLifetimeSeconds,
  });
  return {
    ttlSeconds,
    session: {
      userId: input.userId,
      sessionVersion: input.sessionVersion,
      csrfToken: input.csrfToken,
      createdAt: input.createdAt.toISOString(),
      lastActivityAt: input.lastActivityAt.toISOString(),
      absoluteExpiresAt: sessionAbsoluteExpiresAt(
        input.createdAt,
        input.absoluteLifetimeSeconds,
      ).toISOString(),
    },
  };
}

function touchStoredSession(
  session: StoredSession,
  now: Date,
  config: {
    SESSION_IDLE_TIMEOUT_SECONDS: number;
    SESSION_ABSOLUTE_LIFETIME_SECONDS: number;
  },
): { session: StoredSession; ttlSeconds: number } {
  const createdAt = new Date(session.createdAt);
  return buildStoredSession({
    userId: session.userId,
    sessionVersion: session.sessionVersion,
    csrfToken: session.csrfToken,
    now,
    createdAt,
    lastActivityAt: now,
    idleTimeoutSeconds: config.SESSION_IDLE_TIMEOUT_SECONDS,
    absoluteLifetimeSeconds: config.SESSION_ABSOLUTE_LIFETIME_SECONDS,
  });
}
