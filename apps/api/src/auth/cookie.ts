import type { FastifyReply } from 'fastify';
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from '@sgr-registry/domain';

export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
    secure,
    signed: false,
  };
}

export function setSessionCookie(reply: FastifyReply, sessionId: string, secure: boolean): void {
  void reply.setCookie(SESSION_COOKIE_NAME, sessionId, sessionCookieOptions(secure));
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  void reply.clearCookie(SESSION_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
  });
}
