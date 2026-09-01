import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_LOGIN_FAILED_MESSAGE, capabilitiesForRole } from '@sgr-registry/domain';
import { AuthenticationGuard } from '../../src/auth/authentication.guard';
import { AuthService } from '../../src/auth/auth.service';
import {
  generateOpaqueToken,
  generateTemporaryPassword,
  hashArgon2id,
  hashSessionId,
  safeEqual,
  TEMPORARY_PASSWORD_ALPHABET,
  verifyPassword,
} from '../../src/auth/crypto';
import { CsrfGuard } from '../../src/auth/csrf.guard';
import { RedisUnavailableError } from '../../src/auth/redis.constants';
import { nextLoginFailureState } from '../../src/auth/redis-session.store';
import { RolesGuard } from '../../src/auth/roles.guard';
import type { AuthenticatedUser } from '../../src/auth/authenticated-user';
import type { SessionStore, StoredSession } from '../../src/auth/session-store';

const argonOptions = { memoryCost: 4096, timeCost: 1 };

function httpContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('Argon2id', () => {
  it('hashes and verifies a valid password', async () => {
    const password = 'Dana-SGR-Demo-2026!';
    const hash = await hashArgon2id(password, argonOptions);
    expect(hash).toContain('argon2id');
    expect(await verifyPassword(hash, password)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashArgon2id('Dana-SGR-Demo-2026!', argonOptions);
    expect(await verifyPassword(hash, 'Wrong-Password-2026!')).toBe(false);
  });
});

describe('opaque session id', () => {
  it('has at least 256 bits of entropy and is hashed in Redis', () => {
    const sessionId = generateOpaqueToken(32);
    expect(Buffer.from(sessionId, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(hashSessionId(sessionId)).toHaveLength(64);
    expect(hashSessionId(sessionId)).not.toBe(sessionId);
  });
});

describe('rate limit counter', () => {
  it('counts failures and marks the window as limited after the configured maximum', () => {
    const first = nextLoginFailureState(0, 5, 30);
    expect(first.count).toBe(1);
    expect(first.ttlSeconds).toBe(30);
    expect(first.limited).toBe(false);
    const sixth = nextLoginFailureState(5, 5, 30);
    expect(sixth.count).toBe(6);
    expect(sixth.limited).toBe(true);
  });
});

describe('CSRF comparison', () => {
  it('accepts the matching token and rejects a different one', () => {
    expect(safeEqual('csrf-token-value', 'csrf-token-value')).toBe(true);
    expect(safeEqual('csrf-token-value', 'csrf-token-other')).toBe(false);
  });
});

describe('AuthenticationGuard', () => {
  it('rejects a missing session', async () => {
    const authService = { resolveSession: vi.fn() } as unknown as AuthService;
    const guard = new AuthenticationGuard(authService);
    await expect(guard.canActivate(httpContext({ cookies: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an expired session', async () => {
    const authService = {
      resolveSession: vi.fn().mockRejectedValue(new UnauthorizedException('Требуется авторизация')),
    } as unknown as AuthService;
    const guard = new AuthenticationGuard(authService);
    await expect(
      guard.canActivate(httpContext({ cookies: { sgr_session: 'expired' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an ARCHIVED user', async () => {
    const authService = {
      resolveSession: vi.fn().mockRejectedValue(new UnauthorizedException('Требуется авторизация')),
    } as unknown as AuthService;
    const guard = new AuthenticationGuard(authService);
    await expect(
      guard.canActivate(httpContext({ cookies: { sgr_session: 'archived' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a sessionVersion mismatch', async () => {
    const authService = {
      resolveSession: vi.fn().mockRejectedValue(new UnauthorizedException('Требуется авторизация')),
    } as unknown as AuthService;
    const guard = new AuthenticationGuard(authService);
    await expect(
      guard.canActivate(httpContext({ cookies: { sgr_session: 'stale' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails closed when Redis is unavailable', async () => {
    const authService = {
      resolveSession: vi.fn().mockRejectedValue(new RedisUnavailableError()),
    } as unknown as AuthService;
    const guard = new AuthenticationGuard(authService);
    await expect(
      guard.canActivate(httpContext({ cookies: { sgr_session: 'any' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('RolesGuard', () => {
  it('allows an authorized role and forbids a different role', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(['ADMIN']),
    };
    const guard = new RolesGuard(reflector as never);
    const admin = httpContext({
      user: { role: 'ADMIN' } satisfies Pick<AuthenticatedUser, 'role'>,
    });
    const engineer = httpContext({
      user: { role: 'RESPONSIBLE_ENGINEER' } satisfies Pick<AuthenticatedUser, 'role'>,
    });
    expect(guard.canActivate(admin)).toBe(true);
    expect(() => guard.canActivate(engineer)).toThrow(ForbiddenException);
  });
});

describe('CsrfGuard', () => {
  it('accepts the session token and rejects a missing or wrong token', () => {
    const guard = new CsrfGuard();
    const user = {
      id: 'u1',
      fullName: 'Test',
      email: 'test@example.sgr.local',
      role: 'ADMIN',
      sessionVersion: 1,
      sessionHash: 'abc',
      csrfToken: 'csrf-correct',
      mustChangePassword: false,
    } satisfies AuthenticatedUser;
    expect(
      guard.canActivate(httpContext({ user, headers: { 'x-csrf-token': 'csrf-correct' } })),
    ).toBe(true);
    expect(() => guard.canActivate(httpContext({ user, headers: {} }))).toThrow(ForbiddenException);
    expect(() =>
      guard.canActivate(httpContext({ user, headers: { 'x-csrf-token': 'csrf-wrong' } })),
    ).toThrow(ForbiddenException);
  });
});

describe('AuthService login secrets and dummy verify', () => {
  it('uses dummy Argon2 verify for an unknown email and never returns passwordHash or session id', async () => {
    const hasher = {
      hash: vi.fn(),
      hashUnchecked: vi.fn().mockResolvedValue('dummy-hash'),
      verify: vi.fn().mockResolvedValue(false),
    };
    const sessions: SessionStore = {
      save: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      deleteAllForUser: vi.fn(),
      peekLoginFailures: vi.fn().mockResolvedValue(0),
      incrementLoginFailures: vi
        .fn()
        .mockResolvedValue({ count: 1, ttlSeconds: 30, limited: false }),
      resetLoginFailures: vi.fn(),
    };
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = new AuthService(prisma as never, sessions as never, hasher as never);
    const request = { headers: { 'x-request-id': 'req-1' }, ip: '127.0.0.1', socket: {} };

    await expect(
      service.login(
        { email: 'missing@example.sgr.local', password: 'Dana-SGR-Demo-2026!' },
        request as never,
      ),
    ).rejects.toMatchObject({ message: AUTH_LOGIN_FAILED_MESSAGE });

    expect(hasher.verify).toHaveBeenCalledWith('dummy-hash', 'Dana-SGR-Demo-2026!');
    expect(sessions.incrementLoginFailures).toHaveBeenCalled();
    const audit = prisma.auditLog.create.mock.calls[0]?.[0]?.data as {
      action: string;
      newValue: Record<string, unknown>;
    };
    expect(audit.action).toBe('LOGIN_FAILED');
    expect(JSON.stringify(audit)).not.toMatch(/passwordHash|Dana-SGR-Demo-2026!|sessionId/);
  });

  it('fails closed when the session store is unavailable', async () => {
    const hasher = {
      hashUnchecked: vi.fn().mockResolvedValue('dummy-hash'),
      verify: vi.fn(),
    };
    const sessions = {
      peekLoginFailures: vi.fn().mockRejectedValue(new RedisUnavailableError()),
    };
    const prisma = { user: { findUnique: vi.fn() }, auditLog: { create: vi.fn() } };
    const service = new AuthService(prisma as never, sessions as never, hasher as never);
    let thrown: unknown;
    try {
      await service.login(
        { email: 'alexey.viktorov@example.sgr.local', password: 'Dana-SGR-Demo-2026!' },
        { headers: {}, ip: '127.0.0.1', socket: {} } as never,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(503);
  });
});

describe('capabilities contract', () => {
  it('keeps role mappings aligned with the domain contract', () => {
    expect(capabilitiesForRole('ADMIN')).toContain('MANAGE_USERS');
    expect(capabilitiesForRole('SGR_MANAGER')).toContain('CREATE_ACT');
    expect(capabilitiesForRole('SGR_MANAGER')).toContain('VIEW_REFERENCE_DATA');
    expect(capabilitiesForRole('RESPONSIBLE_ENGINEER')).toContain('VIEW_REFERENCE_DATA');
    expect(capabilitiesForRole('RESPONSIBLE_ENGINEER')).toContain('CREATE_ACT');
    expect(capabilitiesForRole('RESPONSIBLE_ENGINEER')).not.toContain('MANAGE_REFERENCE_DATA');
    expect(capabilitiesForRole('RESPONSIBLE_ENGINEER')).not.toContain('VIEW_ALL_ACTS');
    expect(capabilitiesForRole('RESPONSIBLE_ENGINEER')).not.toContain('MANAGE_PROPOSALS');
    expect(capabilitiesForRole('CONTRACTOR_ENGINEER')).toContain('EDIT_THIRD_PARTY_DEADLINE');
    expect(capabilitiesForRole('CONTRACTOR_ENGINEER')).not.toContain('VIEW_REFERENCE_DATA');
    expect(capabilitiesForRole('CONTRACTOR_ENGINEER')).not.toContain('VIEW_HISTORY');
    expect(capabilitiesForRole('CONTRACTOR_ENGINEER')).not.toContain('VIEW_ASSIGNED_HISTORY');
    expect(capabilitiesForRole('CONTRACTOR_ENGINEER')).not.toContain('VIEW_ACT_CHAT');
    expect(capabilitiesForRole('ADMIN')).toContain('VIEW_ACT_CHAT');
  });
});

describe('temporary password generation', () => {
  it('produces a password that satisfies the policy', () => {
    const password = generateTemporaryPassword();
    expect(password.length).toBeGreaterThanOrEqual(12);
    expect(/[A-Z]/.test(password)).toBe(true);
    expect(/[a-z]/.test(password)).toBe(true);
    expect(/\d/.test(password)).toBe(true);
    expect(/[^A-Za-z0-9]/.test(password)).toBe(true);
  });

  it('keeps the contracted length and alphabet and uses CSPRNG without modulo bias', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../src/auth/crypto.ts'), 'utf8');
    expect(source).toMatch(/randomInt\(/);
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/% alphabet\.length/);
    expect(source).not.toMatch(/% \(i \+ 1\)/);
    for (let i = 0; i < 40; i += 1) {
      const password = generateTemporaryPassword();
      expect(password).toHaveLength(16);
      for (const char of password) {
        expect(TEMPORARY_PASSWORD_ALPHABET).toContain(char);
      }
    }
  });
});

describe('expired session payload', () => {
  it('treats an expired Redis record as unauthorized', async () => {
    const expired: StoredSession = {
      userId: 'user-1',
      sessionVersion: 1,
      csrfToken: 'csrf',
      createdAt: new Date(Date.now() - 1000).toISOString(),
      lastActivityAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const sessions = {
      get: vi.fn().mockResolvedValue(expired),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const prisma = { user: { findUnique: vi.fn() }, auditLog: { create: vi.fn() } };
    const service = new AuthService(prisma as never, sessions as never, {} as never);
    await expect(
      service.resolveSession('opaque-session-id', {
        headers: {},
        ip: '127.0.0.1',
        socket: {},
      } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.delete).toHaveBeenCalled();
  });

  it('rejects a session past absolute lifetime even with recent activity', async () => {
    const expired: StoredSession = {
      userId: 'user-1',
      sessionVersion: 1,
      csrfToken: 'csrf',
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      lastActivityAt: new Date().toISOString(),
      absoluteExpiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    const sessions = {
      get: vi.fn().mockResolvedValue(expired),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const prisma = { user: { findUnique: vi.fn() }, auditLog: { create: vi.fn() } };
    const service = new AuthService(prisma as never, sessions as never, {} as never);
    await expect(
      service.resolveSession('opaque-session-id', {
        headers: {},
        ip: '127.0.0.1',
        socket: {},
      } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.delete).toHaveBeenCalled();
  });
});
