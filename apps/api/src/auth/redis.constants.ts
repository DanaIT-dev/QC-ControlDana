export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export class RedisUnavailableError extends Error {
  constructor() {
    super('Session store unavailable');
    this.name = 'RedisUnavailableError';
  }
}

export function sessionKey(prefix: string, sessionHash: string): string {
  return `${prefix}:sess:${sessionHash}`;
}

export function userSessionsKey(prefix: string, userId: string): string {
  return `${prefix}:user-sess:${userId}`;
}

export function loginFailuresKey(prefix: string, email: string, ip: string): string {
  return `${prefix}:login-fail:${email}:${ip}`;
}
