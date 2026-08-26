import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { loginRequestSchema, type SafeUserProfile } from '@sgr-registry/contracts';
import {
  AUTH_LOGIN_FAILED_MESSAGE,
  AUTH_RATE_LIMITED_MESSAGE,
  capabilitiesForRole,
  CAPABILITY_LABELS,
  isValidEmail,
  normalizeEmail,
  roleLabel,
  type AuthAuditAction,
} from '@sgr-registry/domain';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from './authenticated-user';
import { generateOpaqueToken, hashSessionId } from './crypto';
import { Argon2PasswordHasher } from './password-hasher';
import { PrismaService } from './prisma.tokens';
import { RedisUnavailableError } from './redis.constants';
import { clientIp } from './request-meta';
import { RedisSessionStore } from './redis-session.store';
import type { StoredSession } from './session-store';

const DUMMY_PASSWORD_MATERIAL = 'sgr-dummy-verify-material-not-a-user-password';

@Injectable()
export class AuthService {
  private dummyHashPromise: Promise<string> | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
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
      if (failures >= config.AUTH_LOGIN_MAX_FAILURES) {
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

    const user = await this.prisma.client.user.findUnique({ where: { email } });
    const dummyHash = await this.getDummyHash();

    if (!user || !user.passwordHash || user.status === 'ARCHIVED') {
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

    const passwordMatches = await this.hasher.verify(user.passwordHash, password);
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
    const ttlSeconds = config.SESSION_TTL_SECONDS;
    const session: StoredSession = {
      userId: user.id,
      sessionVersion: user.sessionVersion,
      csrfToken,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    };

    try {
      await this.sessions.save(sessionHash, user.id, session, ttlSeconds);
    } catch (error) {
      throw unavailableOrRethrow(error);
    }

    await this.prisma.client.user.update({
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

    if (Date.parse(stored.expiresAt) <= Date.now()) {
      try {
        await this.sessions.delete(sessionHash, stored.userId);
      } catch {
        // Session is already unusable; fail closed without leaking store errors.
      }
      throw new UnauthorizedException('Требуется авторизация');
    }

    const user = await this.prisma.client.user.findUnique({ where: { id: stored.userId } });
    const config = loadConfig();
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

    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      sessionVersion: user.sessionVersion,
      sessionHash,
      csrfToken: stored.csrfToken,
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
    await this.prisma.client.user.update({
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
    newValue?: { email?: string };
  }): Promise<void> {
    await this.prisma.client.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        newValue: input.newValue ?? undefined,
        ipAddress: input.ipAddress,
        requestId: input.requestId,
        occurredAt: new Date(),
      },
    });
  }
}

export function toSafeProfile(
  user: { id: string; fullName: string; email: string; role: SafeUserProfile['role'] },
  csrfToken: string,
): SafeUserProfile {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    roleLabel: roleLabel(user.role),
    csrfToken,
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
