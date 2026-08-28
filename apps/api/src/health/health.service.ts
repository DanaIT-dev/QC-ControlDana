import { Inject, Injectable } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import type {
  ComponentStatus,
  HealthResponse,
  ReadyResponse,
  SystemStatusResponse,
} from '@sgr-registry/contracts';
import { getPrismaClient } from '@sgr-registry/database';
import Redis from 'ioredis';
import { NotificationDispatcher } from '../notifications/dispatcher';

@Injectable()
export class HealthService {
  constructor(
    @Inject(NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
  ) {}

  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'sgr-registry-api',
      timestamp: new Date().toISOString(),
    };
  }

  async getReadiness(): Promise<ReadyResponse> {
    const config = loadConfig();
    const [postgres, redis, minio, clamav] = await Promise.all([
      this.checkPostgres(config.DATABASE_URL),
      this.checkRedis(config.REDIS_URL),
      this.checkMinio(),
      this.checkClamav(),
    ]);

    const status =
      postgres.status === 'up' &&
      redis.status === 'up' &&
      minio.status === 'up' &&
      clamav.status === 'up'
        ? 'ready'
        : 'not_ready';
    return {
      status,
      timestamp: new Date().toISOString(),
      components: { postgres, redis, minio, clamav },
    };
  }

  async getSystemStatus(): Promise<SystemStatusResponse> {
    const ready = await this.getReadiness();
    const notifications = await this.dispatcher.stats();
    const degraded = notifications.smtp.status === 'down' || notifications.outboxPending > 0;
    return {
      ...ready,
      status: ready.status === 'not_ready' ? 'not_ready' : degraded ? 'degraded' : 'ready',
      components: {
        ...ready.components,
        smtp: notifications.smtp,
      },
      notifications: {
        outboxPending: notifications.outboxPending,
        oldestPendingOutboxAgeMs: notifications.oldestPendingOutboxAgeMs,
        emailQueued: notifications.emailQueued,
        emailFailed: notifications.emailFailed,
        emailDead: notifications.emailDead,
        lastSlaBusinessDate: notifications.lastSlaBusinessDate,
        lastSlaRunAt: notifications.lastSlaRunAt,
        nextSlaRunAt: notifications.nextSlaRunAt,
        smtp: notifications.smtp,
        worker: {
          waiting: notifications.queue.waiting ?? 0,
          active: notifications.queue.active ?? 0,
          failed: notifications.queue.failed ?? 0,
          delayed: notifications.queue.delayed ?? 0,
        },
      },
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

  private async checkMinio(): Promise<ComponentStatus> {
    const started = Date.now();
    try {
      const { createS3Client, ObjectStore, resolveAttachmentBucket } =
        await import('../attachments/object-store');
      const config = loadConfig();
      const store = new ObjectStore(createS3Client(config), resolveAttachmentBucket(config));
      await store.ensureBucket();
      await store.ping();
      return { status: 'up', latencyMs: Date.now() - started };
    } catch {
      return {
        status: 'down',
        latencyMs: Date.now() - started,
        message: 'Object storage is unavailable',
      };
    }
  }

  private async checkClamav(): Promise<ComponentStatus> {
    const started = Date.now();
    try {
      const { ClamdClient } = await import('../attachments/clamd.client');
      const config = loadConfig();
      const client = new ClamdClient(config.CLAMD_HOST, config.CLAMD_PORT);
      await client.ping();
      return { status: 'up', latencyMs: Date.now() - started };
    } catch {
      return {
        status: 'down',
        latencyMs: Date.now() - started,
        message: 'Antivirus is unavailable',
      };
    }
  }
}
