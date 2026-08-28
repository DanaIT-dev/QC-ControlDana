import { Inject, Injectable } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import type Redis from 'ioredis';
import {
  REDIS_CLIENT,
  RedisUnavailableError,
  loginFailuresKey,
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

  async peekLoginFailures(email: string, ip: string): Promise<number> {
    const config = loadConfig();
    const key = loginFailuresKey(config.REDIS_KEY_PREFIX, email, ip);
    try {
      const raw = await this.redis.get(key);
      if (!raw) {
        return 0;
      }
      const count = Number.parseInt(raw, 10);
      return Number.isFinite(count) ? count : 0;
    } catch {
      throw new RedisUnavailableError();
    }
  }

  async incrementLoginFailures(
    email: string,
    ip: string,
    limit: number,
    windowSeconds: number,
  ): Promise<LoginRateLimitState> {
    const config = loadConfig();
    const key = loginFailuresKey(config.REDIS_KEY_PREFIX, email, ip);
    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, windowSeconds);
      }
      const ttl = await this.redis.ttl(key);
      return {
        count,
        ttlSeconds: ttl > 0 ? ttl : windowSeconds,
        limited: count > limit,
      };
    } catch {
      throw new RedisUnavailableError();
    }
  }

  async resetLoginFailures(email: string, ip: string): Promise<void> {
    const config = loadConfig();
    try {
      await this.redis.del(loginFailuresKey(config.REDIS_KEY_PREFIX, email, ip));
    } catch {
      throw new RedisUnavailableError();
    }
  }
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

function userSessionIndexTtlSeconds(session: StoredSession, ttlSeconds: number): number {
  const absoluteRemaining = Math.floor((Date.parse(session.absoluteExpiresAt) - Date.now()) / 1000);
  if (!Number.isFinite(absoluteRemaining)) {
    return ttlSeconds;
  }
  return Math.max(ttlSeconds, absoluteRemaining);
}
