import type { FastifyReply } from 'fastify';
import { SESSION_COOKIE_NAME } from '@sgr-registry/domain';

export function sessionCookieSecure(nodeEnv: string): boolean {
  return nodeEnv === 'production';
}

export function sessionCookieOptions(input: { secure: boolean; maxAgeSeconds: number }) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: input.maxAgeSeconds,
    secure: input.secure,
    signed: false,
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  sessionId: string,
  input: { secure: boolean; maxAgeSeconds: number },
): void {
  void reply.setCookie(SESSION_COOKIE_NAME, sessionId, sessionCookieOptions(input));
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  void reply.clearCookie(SESSION_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
  });
}
