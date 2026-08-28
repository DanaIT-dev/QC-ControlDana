import type { Queue } from 'bullmq';
import { loadConfig } from '@sgr-registry/config';
import type { PrismaClient } from '@sgr-registry/database';
import {
  nextDailyEvaluationAt,
  parseWorkerHeartbeat,
  resolveWorkerHeartbeatKey,
} from '@sgr-registry/domain';
import type Redis from 'ioredis';
import nodemailer from 'nodemailer';

export async function probeSmtp(prisma: PrismaClient): Promise<{
  status: 'up' | 'down' | 'disabled';
  latencyMs?: number;
}> {
  const config = loadConfig();
  const settings = await prisma.systemSettings.findUnique({ where: { id: 'default' } });
  if (!config.EMAIL_ENABLED || settings?.emailEnabled === false) {
    return { status: 'disabled' };
  }
  const started = Date.now();
  try {
    const transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth:
        config.SMTP_USER && config.SMTP_PASSWORD
          ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
          : undefined,
      connectionTimeout: 2000,
      greetingTimeout: 2000,
      socketTimeout: 2000,
    });
    try {
      await transporter.verify();
      return { status: 'up', latencyMs: Date.now() - started };
    } finally {
      transporter.close();
    }
  } catch {
    return { status: 'down', latencyMs: Date.now() - started };
  }
}

export async function collectNotificationOps(input: {
  prisma: PrismaClient;
  queue: Queue;
  redis: Redis;
}) {
  const [pending, oldest, emailQueued, emailFailed, emailDead, sla, settings, heartbeatRaw] =
    await Promise.all([
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
      input.redis.get(resolveWorkerHeartbeatKey()),
    ]);
  const counts = await input.queue.getJobCounts();
  const smtp = await probeSmtp(input.prisma);
  const heartbeat = parseWorkerHeartbeat(heartbeatRaw);
  return {
    outboxPending: pending,
    oldestPendingOutboxAgeMs: oldest ? Date.now() - oldest.createdAt.getTime() : null,
    emailQueued,
    emailFailed,
    emailDead,
    lastSlaBusinessDate: sla?.lastSuccessfulBusinessDate ?? null,
    lastSlaRunAt: sla?.lastRunAt?.toISOString() ?? null,
    nextSlaRunAt: nextDailyEvaluationAt(settings?.dailyEvaluationMinuteOfDay ?? 480).toISOString(),
    smtp,
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
