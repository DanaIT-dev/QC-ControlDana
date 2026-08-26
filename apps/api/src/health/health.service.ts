import { Injectable } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import type { ComponentStatus, HealthResponse, ReadyResponse } from '@sgr-registry/contracts';
import { getPrismaClient } from '@sgr-registry/database';
import Redis from 'ioredis';

@Injectable()
export class HealthService {
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'sgr-registry-api',
      timestamp: new Date().toISOString(),
    };
  }

  async getReadiness(): Promise<ReadyResponse> {
    const config = loadConfig();
    const [postgres, redis] = await Promise.all([
      this.checkPostgres(config.DATABASE_URL),
      this.checkRedis(config.REDIS_URL),
    ]);

    const status = postgres.status === 'up' && redis.status === 'up' ? 'ready' : 'not_ready';
    return {
      status,
      timestamp: new Date().toISOString(),
      components: { postgres, redis },
    };
  }

  private async checkPostgres(databaseUrl: string): Promise<ComponentStatus> {
    const started = Date.now();
    try {
      const prisma = getPrismaClient(databaseUrl);
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'up', latencyMs: Date.now() - started };
    } catch {
      return {
        status: 'down',
        latencyMs: Date.now() - started,
        message: 'PostgreSQL is unavailable',
      };
    }
  }

  private async checkRedis(redisUrl: string): Promise<ComponentStatus> {
    const started = Date.now();
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      lazyConnect: true,
    });
    try {
      await redis.connect();
      await redis.ping();
      return { status: 'up', latencyMs: Date.now() - started };
    } catch {
      return {
        status: 'down',
        latencyMs: Date.now() - started,
        message: 'Redis is unavailable',
      };
    } finally {
      redis.disconnect();
    }
  }
}
