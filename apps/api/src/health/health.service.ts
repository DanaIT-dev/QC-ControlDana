import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import type {
  ComponentStatus,
  HealthResponse,
  ReadyResponse,
  SystemStatusResponse,
} from '@sgr-registry/contracts';
import { getPrismaClient } from '@sgr-registry/database';
import { collectNotificationOps, NOTIFICATION_QUEUE } from '@sgr-registry/jobs';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../auth/prisma.tokens';
import { REDIS_CLIENT } from '../auth/redis.constants';

@Injectable()
export class HealthService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue,
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
    const notifications = await collectNotificationOps({
      prisma: this.prismaService.client,
      queue: this.queue,
      redis: this.redis,
    });
    const degraded =
      notifications.smtp.status === 'down' ||
      notifications.outboxPending > 0 ||
      notifications.worker.status === 'down';
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
        worker: notifications.worker,
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
        await import('../attachments/object-store.js');
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
      const { ClamdClient } = await import('../attachments/clamd.client.js');
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
