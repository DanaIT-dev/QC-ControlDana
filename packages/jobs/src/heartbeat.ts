import { Logger } from '@nestjs/common';
import {
  serializeWorkerHeartbeat,
  WORKER_HEARTBEAT_REFRESH_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
  type WorkerHeartbeatPayload,
  resolveWorkerHeartbeatKey,
} from '@sgr-registry/domain';
import type Redis from 'ioredis';

export class WorkerHeartbeat {
  private readonly logger = new Logger(WorkerHeartbeat.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly startedAt = new Date().toISOString();

  constructor(private readonly redis: Redis) {}

  async start(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => {
      void this.beat().catch((error) => {
        this.logger.warn(
          `Heartbeat refresh failed code=${error instanceof Error ? error.name : 'HEARTBEAT_FAILED'}`,
        );
      });
    }, WORKER_HEARTBEAT_REFRESH_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const key = resolveWorkerHeartbeatKey();
    const raw = await this.redis.get(key).catch(() => null);
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { pid?: number };
      if (parsed.pid === process.pid) {
        await this.redis.del(key);
      }
    } catch {
      return;
    }
  }

  private async beat(): Promise<void> {
    const payload: WorkerHeartbeatPayload = {
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
    };
    await this.redis.set(
      resolveWorkerHeartbeatKey(),
      serializeWorkerHeartbeat(payload),
      'EX',
      WORKER_HEARTBEAT_TTL_SECONDS,
    );
  }
}
