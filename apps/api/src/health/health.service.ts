import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { loadConfig, redisTlsOptions } from '@sgr-registry/config';
import type {
  ComponentHealth,
  ComponentStatus,
  HealthResponse,
  ReadyResponse,
  SystemStatusOverviewItem,
  SystemStatusResponse,
} from '@sgr-registry/contracts';
import { getPrismaClient } from '@sgr-registry/database';
import {
  collectNotificationDbOps,
  collectNotificationRuntimeOps,
  NOTIFICATION_QUEUE,
  probeSmtp,
} from '@sgr-registry/jobs';
import type { Queue } from 'bullmq';
import type { FastifyRequest } from 'fastify';
import Redis from 'ioredis';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../auth/prisma.tokens';
import { REDIS_CLIENT } from '../auth/redis.constants';

const SECRET_PATTERN =
  /password|passwordHash|token|cookie|csrf|DATABASE_URL|REDIS_URL|redis:\/\/|postgres(ql)?:\/\/|minio|secret|acl|stack|at \s+\S+:\d+/i;

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
    const [postgres, redis, objectStorage, clamav] = await Promise.all([
      this.checkPostgres(config.DATABASE_URL),
      this.checkRedis(config.REDIS_URL),
      this.checkObjectStorage(),
      this.checkClamav(),
    ]);

    const status =
      postgres.status === 'up' &&
      redis.status === 'up' &&
      objectStorage.status === 'up' &&
      clamav.status === 'up'
        ? 'ready'
        : 'not_ready';
    return {
      status,
      timestamp: new Date().toISOString(),
      components: { postgres, redis, objectStorage, clamav },
    };
  }

  async getSystemStatus(
    user: AuthenticatedUser,
    request: FastifyRequest,
  ): Promise<SystemStatusResponse> {
    const checkedAt = new Date().toISOString();
    const ready = await this.getReadiness();
    const web = await this.checkWeb();
    const migrations = await this.checkMigrations(user, request);
    let notifications: {
      emailEnabled: boolean;
      outboxPending: number;
      oldestPendingOutboxAgeMs: number | null;
      emailQueued: number;
      emailFailed: number;
      emailDead: number;
      lastSlaBusinessDate: string | null;
      lastSlaRunAt: string | null;
      nextSlaRunAt: string | null;
      smtp: { status: 'up' | 'down' | 'disabled'; latencyMs?: number };
      worker: {
        status: 'up' | 'down';
        heartbeatAgeMs: number | null;
        waiting: number;
        active: number;
        failed: number;
        delayed: number;
      };
    };
    try {
      const db = await this.prismaService.withUser(user, request, () =>
        collectNotificationDbOps({
          prisma: this.prismaService.client,
        }),
      );
      const runtime = await collectNotificationRuntimeOps({
        queue: this.queue,
        redis: this.redis,
      });
      const smtp = await probeSmtp({ emailEnabled: db.emailEnabled });
      notifications = { ...db, ...runtime, smtp };
    } catch {
      notifications = {
        emailEnabled: false,
        outboxPending: 0,
        oldestPendingOutboxAgeMs: null,
        emailQueued: 0,
        emailFailed: 0,
        emailDead: 0,
        lastSlaBusinessDate: null,
        lastSlaRunAt: null,
        nextSlaRunAt: null,
        smtp: { status: 'down' },
        worker: {
          status: 'down',
          heartbeatAgeMs: null,
          waiting: 0,
          active: 0,
          failed: 0,
          delayed: 0,
        },
      };
    }
    const queueStatus = queueHealth(notifications);
    const overview: SystemStatusOverviewItem[] = [
      { component: 'Web', status: web.status, checkedAt, message: safeMessage(web.message) },
      { component: 'API', status: 'up', checkedAt, message: safeMessage(undefined) },
      {
        component: 'Worker',
        status: notifications.worker.status === 'up' ? 'up' : 'down',
        checkedAt,
        message: safeMessage(
          notifications.worker.status === 'up' ? undefined : 'Фоновый обработчик недоступен',
        ),
      },
      {
        component: 'PostgreSQL',
        status: ready.components.postgres.status === 'up' ? 'up' : 'down',
        checkedAt,
        message: safeMessage(ready.components.postgres.message),
      },
      {
        component: 'Redis',
        status: ready.components.redis.status === 'up' ? 'up' : 'down',
        checkedAt,
        message: safeMessage(ready.components.redis.message),
      },
      {
        component: 'Хранилище',
        status: ready.components.objectStorage.status === 'up' ? 'up' : 'down',
        checkedAt,
        message: safeMessage(ready.components.objectStorage.message),
      },
      {
        component: 'ClamAV',
        status: ready.components.clamav.status === 'up' ? 'up' : 'down',
        checkedAt,
        message: safeMessage(ready.components.clamav.message),
      },
      {
        component: 'Миграции',
        status: migrations.status,
        checkedAt,
        message: safeMessage(migrations.message),
      },
      {
        component: 'Фоновые очереди',
        status: queueStatus.status,
        checkedAt,
        message: safeMessage(queueStatus.message),
      },
    ];
    const degraded =
      overview.some((item) => item.status === 'degraded') ||
      notifications.smtp.status === 'down' ||
      notifications.outboxPending > 0 ||
      notifications.worker.status === 'down';
    const down = overview.some((item) => item.status === 'down') || ready.status === 'not_ready';
    return {
      ...ready,
      status: down ? 'not_ready' : degraded ? 'degraded' : 'ready',
      timestamp: checkedAt,
      components: {
        ...ready.components,
        smtp: notifications.smtp,
      },
      overview,
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

  private async checkWeb(): Promise<{ status: ComponentHealth; message?: string }> {
    try {
      const origin = loadConfig().WEB_ORIGIN;
      const response = await fetch(origin, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(800),
      });
      if (response.status >= 200 && response.status < 500) {
        return { status: 'up' };
      }
      return { status: 'degraded', message: 'Web отвечает с ошибкой' };
    } catch {
      return { status: 'down', message: 'Web недоступен' };
    }
  }

  private async checkMigrations(
    user: AuthenticatedUser,
    request: FastifyRequest,
  ): Promise<{ status: ComponentHealth; message?: string }> {
    try {
      const rows = await this.prismaService.withUser(
        user,
        request,
        () =>
          this.prismaService.client.$queryRaw<
            Array<{
              status: string;
              pending: number;
              failed: number;
              last_finished_at: Date | null;
            }>
          >`SELECT status, pending, failed, last_finished_at FROM public.sgr_migration_health()`,
      );
      const row = rows[0];
      if (!row) {
        return { status: 'checking', message: 'Миграции проверяются' };
      }
      if (row.status === 'down') {
        return { status: 'down', message: 'Миграции недоступны' };
      }
      if (row.status === 'degraded') {
        return { status: 'degraded', message: 'Есть незавершённые миграции' };
      }
      return { status: 'up' };
    } catch {
      return { status: 'checking', message: 'Миграции проверяются' };
    }
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
      ...redisTlsOptions(redisUrl),
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

  private async checkObjectStorage(): Promise<ComponentStatus> {
    const started = Date.now();
    try {
      const { createObjectStore } = await import('../attachments/object-store.js');
      const store = createObjectStore(loadConfig());
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

function queueHealth(notifications: {
  outboxPending: number;
  worker: { status: 'up' | 'down'; waiting: number; failed: number };
}): { status: ComponentHealth; message?: string } {
  if (notifications.worker.status !== 'up') {
    return { status: 'down', message: 'Очереди недоступны' };
  }
  if (notifications.outboxPending > 0 || notifications.worker.failed > 0) {
    return { status: 'degraded', message: 'Есть задания с ошибками или ожиданием' };
  }
  return { status: 'up' };
}

function safeMessage(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  if (SECRET_PATTERN.test(message)) {
    return 'Компонент недоступен';
  }
  return message.slice(0, 180);
}
