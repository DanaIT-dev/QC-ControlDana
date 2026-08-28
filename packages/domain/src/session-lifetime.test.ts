import { describe, expect, it } from 'vitest';
import {
  SESSION_ABSOLUTE_LIFETIME_SECONDS,
  SESSION_IDLE_TIMEOUT_SECONDS,
  isSessionExpired,
  redisSessionTtlSeconds,
  remainingAbsoluteSeconds,
  remainingIdleSeconds,
  sessionAbsoluteExpiresAt,
} from './session-lifetime';

const HOUR = 60 * 60 * 1000;
const createdAtMs = Date.parse('2026-08-01T00:00:00.000Z');

function timing(nowMs: number, lastActivityAtMs = createdAtMs) {
  return {
    createdAtMs,
    lastActivityAtMs,
    nowMs,
    idleTimeoutSeconds: SESSION_IDLE_TIMEOUT_SECONDS,
    absoluteLifetimeSeconds: SESSION_ABSOLUTE_LIFETIME_SECONDS,
  };
}

describe('session lifetime', () => {
  it('uses 12 hour idle and 7 day absolute defaults', () => {
    expect(SESSION_IDLE_TIMEOUT_SECONDS).toBe(12 * 60 * 60);
    expect(SESSION_ABSOLUTE_LIFETIME_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it('keeps a session alive before idle timeout', () => {
    const input = timing(createdAtMs + 11 * HOUR);
    expect(isSessionExpired(input)).toBe(false);
    expect(redisSessionTtlSeconds(input)).toBe(60 * 60);
    expect(remainingIdleSeconds(input)).toBe(60 * 60);
  });

  it('expires on idle even when absolute lifetime remains', () => {
    const input = timing(createdAtMs + 13 * HOUR);
    expect(isSessionExpired(input)).toBe(true);
    expect(remainingAbsoluteSeconds(input)).toBeGreaterThan(0);
  });

  it('does not extend absolute lifetime when activity is refreshed', () => {
    const refreshed = timing(createdAtMs + 6 * HOUR, createdAtMs + 6 * HOUR);
    const originalAbsolute = remainingAbsoluteSeconds(timing(createdAtMs + 6 * HOUR));
    expect(remainingAbsoluteSeconds(refreshed)).toBe(originalAbsolute);
    expect(redisSessionTtlSeconds(refreshed)).toBe(SESSION_IDLE_TIMEOUT_SECONDS);
  });

  it('expires at absolute lifetime even with recent activity', () => {
    const nowMs = createdAtMs + SESSION_ABSOLUTE_LIFETIME_SECONDS * 1000 + 1000;
    const input = timing(nowMs, nowMs - HOUR);
    expect(isSessionExpired(input)).toBe(true);
    expect(remainingIdleSeconds(input)).toBeGreaterThan(0);
    expect(remainingAbsoluteSeconds(input)).toBeLessThanOrEqual(0);
  });

  it('caps redis TTL at remaining absolute lifetime', () => {
    const nowMs = createdAtMs + SESSION_ABSOLUTE_LIFETIME_SECONDS * 1000 - 30 * 60 * 1000;
    const input = timing(nowMs, nowMs);
    expect(redisSessionTtlSeconds(input)).toBe(30 * 60);
  });

  it('computes absolute expiry from createdAt only', () => {
    const createdAt = new Date(createdAtMs);
    expect(
      sessionAbsoluteExpiresAt(createdAt, SESSION_ABSOLUTE_LIFETIME_SECONDS).toISOString(),
    ).toBe('2026-08-08T00:00:00.000Z');
  });
});
