export const SESSION_IDLE_TIMEOUT_SECONDS = 12 * 60 * 60;
export const SESSION_ABSOLUTE_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

export interface SessionLifetimeInput {
  createdAtMs: number;
  lastActivityAtMs: number;
  nowMs: number;
  idleTimeoutSeconds: number;
  absoluteLifetimeSeconds: number;
}

export function remainingIdleSeconds(input: SessionLifetimeInput): number {
  return Math.floor(
    (input.lastActivityAtMs + input.idleTimeoutSeconds * 1000 - input.nowMs) / 1000,
  );
}

export function remainingAbsoluteSeconds(input: SessionLifetimeInput): number {
  return Math.floor(
    (input.createdAtMs + input.absoluteLifetimeSeconds * 1000 - input.nowMs) / 1000,
  );
}

export function redisSessionTtlSeconds(input: SessionLifetimeInput): number {
  return Math.max(0, Math.min(remainingIdleSeconds(input), remainingAbsoluteSeconds(input)));
}

export function isSessionExpired(input: SessionLifetimeInput): boolean {
  return redisSessionTtlSeconds(input) <= 0;
}

export function sessionAbsoluteExpiresAt(createdAt: Date, absoluteLifetimeSeconds: number): Date {
  return new Date(createdAt.getTime() + absoluteLifetimeSeconds * 1000);
}
