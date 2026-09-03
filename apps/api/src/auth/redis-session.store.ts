import { Inject, Injectable } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import type Redis from 'ioredis';
import {
  REDIS_CLIENT,
  RedisUnavailableError,
  loginFailuresEmailKey,
  loginFailuresIpKey,
  sessionKey,
  userSessionsKey,
} from './redis.constants';
import type { LoginRateLimitState, SessionStore, StoredSession } from './session-store';

@Injectable()
export class RedisSessionStore implements SessionStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async save(
    sessionHash: string,
    userId: string,
    session: StoredSession,
    ttlSeconds: number,
  ): Promise<void> {
    const config = loadConfig();
    const prefix = config.REDIS_KEY_PREFIX;
    try {
      const pipeline = this.redis.pipeline();
      pipeline.set(sessionKey(prefix, sessionHash), JSON.stringify(session), 'EX', ttlSeconds);
      pipeline.sadd(userSessionsKey(prefix, userId), sessionHash);
      const indexTtl = userSessionIndexTtlSeconds(session, ttlSeconds);
      pipeline.expire(userSessionsKey(prefix, userId), indexTtl);
      const result = await pipeline.exec();
      if (!result) {
        throw new RedisUnavailableError();
      }
    } catch (error) {
      if (error instanceof RedisUnavailableError) {
        throw error;
      }
      throw new RedisUnavailableError();
    }
  }

  async get(sessionHash: string): Promise<StoredSession | null> {
    const config = loadConfig();
    try {
      const raw = await this.redis.get(sessionKey(config.REDIS_KEY_PREFIX, sessionHash));
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as StoredSession;
    } catch {
      throw new RedisUnavailableError();
    }
  }

  async delete(sessionHash: string, userId: string): Promise<void> {
    const config = loadConfig();
    const prefix = config.REDIS_KEY_PREFIX;
    try {
      const pipeline = this.redis.pipeline();
      pipeline.del(sessionKey(prefix, sessionHash));
      pipeline.srem(userSessionsKey(prefix, userId), sessionHash);
      await pipeline.exec();
    } catch {
      throw new RedisUnavailableError();
    }
  }

  async countForUsers(userIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (userIds.length === 0) {
      return counts;
    }
    const config = loadConfig();
    const prefix = config.REDIS_KEY_PREFIX;
    try {
      const pipeline = this.redis.pipeline();
      for (const userId of userIds) {
        pipeline.scard(userSessionsKey(prefix, userId));
      }
      const result = await pipeline.exec();
      userIds.forEach((userId, index) => {
        const value = result?.[index]?.[1];
        const count = typeof value === 'number' ? value : Number(value);
        counts.set(userId, Number.isFinite(count) ? count : 0);
      });
      return counts;
    } catch {
      return counts;
    }
  }

  async deleteAllForUser(userId: string): Promise<void> {
    const config = loadConfig();
    const prefix = config.REDIS_KEY_PREFIX;
    try {
      const hashes = await this.redis.smembers(userSessionsKey(prefix, userId));
      const pipeline = this.redis.pipeline();
      for (const hash of hashes) {
        pipeline.del(sessionKey(prefix, hash));
      }
      pipeline.del(userSessionsKey(prefix, userId));
      await pipeline.exec();
    } catch {
      throw new RedisUnavailableError();
    }
  }

  async peekLoginFailures(
    email: string,
    ip: string,
  ): Promise<{ emailCount: number; ipCount: number }> {
    const config = loadConfig();
    const prefix = config.REDIS_KEY_PREFIX;
    try {
      const [emailRaw, ipRaw] = await this.redis.mget(
        loginFailuresEmailKey(prefix, email),
        loginFailuresIpKey(prefix, ip),
      );
      return {
        emailCount: parseFailureCount(emailRaw),
        ipCount: parseFailureCount(ipRaw),
      };
    } catch {
      throw new RedisUnavailableError();
    }
  }

  async incrementLoginFailures(
    email: string,
    ip: string,
    emailLimit: number,
    ipLimit: number,
    windowSeconds: number,
  ): Promise<LoginRateLimitState> {
    const config = loadConfig();
    const prefix = config.REDIS_KEY_PREFIX;
    const emailKey = loginFailuresEmailKey(prefix, email);
    const ipKey = loginFailuresIpKey(prefix, ip);
    try {
      const emailCount = await this.redis.incr(emailKey);
      if (emailCount === 1) {
        await this.redis.expire(emailKey, windowSeconds);
      }
      const ipCount = await this.redis.incr(ipKey);
      if (ipCount === 1) {
        await this.redis.expire(ipKey, windowSeconds);
      }
      const ttl = await this.redis.ttl(emailKey);
      return {
        count: emailCount,
        ttlSeconds: ttl > 0 ? ttl : windowSeconds,
        limited: isLoginRateLimited(emailCount, ipCount, emailLimit, ipLimit),
      };
    } catch {
      throw new RedisUnavailableError();
    }
  }

  async resetLoginFailures(email: string, _ip: string): Promise<void> {
    const config = loadConfig();
    try {
      await this.redis.del(loginFailuresEmailKey(config.REDIS_KEY_PREFIX, email));
    } catch {
      throw new RedisUnavailableError();
    }
  }
}

export function isLoginRateLimited(
  emailCount: number,
  ipCount: number,
  emailLimit: number,
  ipLimit: number,
): boolean {
  return emailCount >= emailLimit || ipCount >= ipLimit;
}

export function nextLoginFailureState(
  currentCount: number,
  limit: number,
  windowSeconds: number,
): LoginRateLimitState {
  const count = currentCount + 1;
  return {
    count,
    ttlSeconds: windowSeconds,
    limited: count > limit,
  };
}

function parseFailureCount(raw: string | null | undefined): number {
  if (!raw) {
    return 0;
  }
  const count = Number.parseInt(raw, 10);
  return Number.isFinite(count) ? count : 0;
}

function userSessionIndexTtlSeconds(session: StoredSession, ttlSeconds: number): number {
  const absoluteRemaining = Math.floor((Date.parse(session.absoluteExpiresAt) - Date.now()) / 1000);
  if (!Number.isFinite(absoluteRemaining)) {
    return ttlSeconds;
  }
  return Math.max(ttlSeconds, absoluteRemaining);
}
