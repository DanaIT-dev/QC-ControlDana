import type { Queue } from 'bullmq';
import { loadConfig } from '@sgr-registry/config';
import type { PrismaClient } from '@sgr-registry/database';
import {
  nextDailyEvaluationAt,
  parseWorkerHeartbeat,
  resolveWorkerHeartbeatKey,
} from '@sgr-registry/domain';
import type Redis from 'ioredis';
import { probeSmtpTransport } from './dispatcher';

export async function probeSmtp(input: { emailEnabled: boolean }): Promise<{
  status: 'up' | 'down' | 'disabled';
  latencyMs?: number;
}> {
  if (!input.emailEnabled) {
    return { status: 'disabled' };
  }
  return probeSmtpTransport(loadConfig());
}

export async function collectNotificationDbOps(input: { prisma: PrismaClient }) {
  const [pending, oldest, emailQueued, emailFailed, emailDead, sla, settings] = await Promise.all([
    input.prisma.outboxEvent.count({
      where: { status: { in: ['PENDING', 'CLAIMED', 'FAILED'] } },
    }),
    input.prisma.outboxEvent.findFirst({
      where: { status: { in: ['PENDING', 'FAILED'] } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    input.prisma.emailDelivery.count({ where: { status: { in: ['QUEUED', 'SENDING'] } } }),
    input.prisma.emailDelivery.count({ where: { status: 'FAILED' } }),
    input.prisma.emailDelivery.count({ where: { status: 'DEAD' } }),
    input.prisma.slaEvaluationState.findUnique({ where: { id: 'default' } }),
    input.prisma.systemSettings.findUnique({ where: { id: 'default' } }),
  ]);
  return {
    emailEnabled: loadConfig().EMAIL_ENABLED && settings?.emailEnabled !== false,
    outboxPending: pending,
    oldestPendingOutboxAgeMs: oldest ? Date.now() - oldest.createdAt.getTime() : null,
    emailQueued,
    emailFailed,
    emailDead,
    lastSlaBusinessDate: sla?.lastSuccessfulBusinessDate ?? null,
    lastSlaRunAt: sla?.lastRunAt?.toISOString() ?? null,
    nextSlaRunAt: nextDailyEvaluationAt(settings?.dailyEvaluationMinuteOfDay ?? 480).toISOString(),
  };
}

export async function collectNotificationRuntimeOps(input: { queue: Queue; redis: Redis }) {
  const [counts, heartbeatRaw] = await Promise.all([
    input.queue.getJobCounts(),
    input.redis.get(resolveWorkerHeartbeatKey()),
  ]);
  const heartbeat = parseWorkerHeartbeat(heartbeatRaw);
  return {
    worker: {
      status: heartbeat.status,
      heartbeatAgeMs: heartbeat.ageMs,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    },
  };
}

export async function collectNotificationOps(input: {
  prisma: PrismaClient;
  queue: Queue;
  redis: Redis;
}) {
  const db = await collectNotificationDbOps({ prisma: input.prisma });
  const runtime = await collectNotificationRuntimeOps({ queue: input.queue, redis: input.redis });
  const smtp = await probeSmtp({ emailEnabled: db.emailEnabled });
  return {
    outboxPending: db.outboxPending,
    oldestPendingOutboxAgeMs: db.oldestPendingOutboxAgeMs,
    emailQueued: db.emailQueued,
    emailFailed: db.emailFailed,
    emailDead: db.emailDead,
    lastSlaBusinessDate: db.lastSlaBusinessDate,
    lastSlaRunAt: db.lastSlaRunAt,
    nextSlaRunAt: db.nextSlaRunAt,
    smtp,
    worker: runtime.worker,
  };
}
