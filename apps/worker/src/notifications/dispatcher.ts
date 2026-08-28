import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { loadConfig, type AppConfig } from '@sgr-registry/config';
import { getPrismaClient, Prisma, type PrismaClient } from '@sgr-registry/database';
import {
  EMAIL_DELIVER_JOB,
  EMAIL_MAX_ATTEMPTS,
  OUTBOX_DISPATCH_JOB,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RECOVERY_JOB,
  SLA_EVALUATE_JOB,
  assertSafeNotificationPayload,
  buildActUrl,
  buildOccurrenceKey,
  calendarDateInTimeZone,
  emailJobId,
  isTerminalAttempt,
  nextAttemptAt,
  notificationTitle,
  outboxJobId,
  overdueDaysOf,
  reachedEscalationThresholds,
  recipientsForDeadlineAlert,
  renderNotificationEmail,
  slaCatchUpJobId,
  suppressActorRecipients,
  nextDailyEvaluationAt,
  type NotificationType,
  type SlaClockKind,
} from '@sgr-registry/domain';
import nodemailer from 'nodemailer';
import { writeAuditLog, toJsonValue } from './audit-writer';
import { NOTIFICATION_QUEUE } from './outbox.writer';

type OutboxPayload = {
  type: NotificationType;
  occurrenceBase: string;
  actId: string | null;
  defectItemId: string | null;
  attachmentId?: string | null;
  actorUserId?: string | null;
  automatic?: boolean;
  kind?: SlaClockKind;
  cycle?: number;
  threshold?: number | null;
  businessDate?: string;
  deadline?: string | null;
  body: string;
  extraRecipientIds?: string[];
};

@Injectable()
export class NotificationDispatcher {
  constructor(@InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue) {
    this.prisma = getPrismaClient(loadConfig().DATABASE_URL);
  }

  private readonly prisma: PrismaClient;
  private readonly logger = new Logger(NotificationDispatcher.name);

  async dispatch(outboxId: string): Promise<void> {
    const claimed = await this.claim(outboxId);
    if (!claimed) {
      return;
    }
    try {
      const payload = claimed.payload as OutboxPayload;
      assertSafeNotificationPayload(payload);
      if (payload.kind && payload.cycle !== undefined && payload.deadline !== undefined) {
        if (!payload.defectItemId) {
          await this.markProcessed(claimed.id);
          return;
        }
        const clock = await this.prisma.slaClock.findUnique({
          where: {
            defectItemId_kind: { defectItemId: payload.defectItemId, kind: payload.kind },
          },
        });
        const current = clock?.deadline ? calendarDateInTimeZone(clock.deadline) : null;
        if (!clock || clock.cycle !== payload.cycle || current !== (payload.deadline ?? null)) {
          await this.markProcessed(claimed.id);
          return;
        }
        if (clock.state === 'COMPLETED' && payload.type.startsWith('SLA_')) {
          await this.markProcessed(claimed.id);
          return;
        }
      }
      const recipientIds = await this.resolveRecipients(payload);
      if (recipientIds.length === 0) {
        await this.markProcessed(claimed.id);
        return;
      }
      const event = await this.prisma.notificationEvent.upsert({
        where: { occurrenceKey: payload.occurrenceBase },
        update: {},
        create: {
          id: randomUUID(),
          type: payload.type,
          occurrenceKey: payload.occurrenceBase,
          actorUserId: payload.actorUserId ?? null,
          actId: payload.actId,
          defectItemId: payload.defectItemId,
          attachmentId: payload.attachmentId ?? null,
          payload: {
            title: notificationTitle(payload.type),
            body: payload.body,
            kind: payload.kind ?? null,
            cycle: payload.cycle ?? null,
            threshold: payload.threshold ?? null,
          },
          occurredAt: new Date(),
        },
      });
      for (const userId of recipientIds) {
        const recipient = await this.prisma.notificationRecipient.upsert({
          where: {
            notificationEventId_userId: { notificationEventId: event.id, userId },
          },
          update: {},
          create: {
            id: randomUUID(),
            notificationEventId: event.id,
            userId,
          },
        });
        const delivery = await this.prisma.emailDelivery.upsert({
          where: { notificationRecipientId: recipient.id },
          update: {},
          create: {
            id: randomUUID(),
            notificationRecipientId: recipient.id,
            updatedAt: new Date(),
          },
        });
        if (delivery.status === 'QUEUED' || delivery.status === 'FAILED') {
          try {
            await this.queue.add(
              EMAIL_DELIVER_JOB,
              { deliveryId: delivery.id },
              {
                jobId: emailJobId(delivery.id),
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
              },
            );
          } catch (error) {
            this.logger.warn(
              `Email enqueue deferred id=${delivery.id} code=${error instanceof Error ? error.name : 'ENQUEUE_FAILED'}`,
            );
          }
        }
      }
      await this.markProcessed(claimed.id);
    } catch (error) {
      const attempts = claimed.attempts;
      const dead = isTerminalAttempt(attempts, OUTBOX_MAX_ATTEMPTS);
      await this.prisma.outboxEvent.update({
        where: { id: claimed.id },
        data: {
          status: dead ? 'DEAD' : 'FAILED',
          lastErrorCode: 'DISPATCH_FAILED',
          availableAt: nextAttemptAt(attempts),
          updatedAt: new Date(),
        },
      });
      if (dead) {
        await writeAuditLog(this.prisma, {
          actor: null,
          action: 'OUTBOX_DEAD',
          entityType: 'OUTBOX_EVENT',
          entityId: claimed.id,
          newValue: toJsonValue({ type: claimed.type }),
          source: 'SYSTEM',
        });
      }
      this.logger.warn(error instanceof Error ? error.message : 'dispatch failed');
      if (!dead) {
        throw error;
      }
    }
  }

  async deliver(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.emailDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        recipient: {
          include: { event: true, user: true },
        },
      },
    });
    if (!delivery || delivery.status === 'SENT' || delivery.status === 'DEAD') {
      return;
    }
    if (delivery.recipient.revokedAt || delivery.recipient.user.status === 'ARCHIVED') {
      await this.prisma.emailDelivery.update({
        where: { id: deliveryId },
        data: { status: 'DEAD', lastErrorCode: 'REVOKED', updatedAt: new Date() },
      });
      return;
    }
    const settings = await this.prisma.systemSettings.findUnique({ where: { id: 'default' } });
    const config = loadConfig();
    if (!config.EMAIL_ENABLED || settings?.emailEnabled === false) {
      await this.prisma.emailDelivery.update({
        where: { id: deliveryId },
        data: { status: 'QUEUED', lastErrorCode: 'EMAIL_DISABLED', updatedAt: new Date() },
      });
      return;
    }
    const actId = delivery.recipient.event.actId;
    if (!actId) {
      await this.prisma.emailDelivery.update({
        where: { id: deliveryId },
        data: { status: 'DEAD', lastErrorCode: 'NO_ACT', updatedAt: new Date() },
      });
      return;
    }
    await this.prisma.emailDelivery.update({
      where: { id: deliveryId },
      data: { status: 'SENDING', attempts: { increment: 1 }, updatedAt: new Date() },
    });
    try {
      const payload = delivery.recipient.event.payload as { title?: string; body?: string };
      const mail = renderNotificationEmail({
        title:
          payload.title ?? notificationTitle(delivery.recipient.event.type as NotificationType),
        body: payload.body ?? notificationTitle(delivery.recipient.event.type as NotificationType),
        actUrl: buildActUrl(
          config.PUBLIC_APP_URL,
          actId,
          delivery.recipient.event.defectItemId ?? undefined,
        ),
      });
      const info = await sendMail(config, delivery.recipient.user.email, mail);
      await this.prisma.emailDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: info.messageId,
          lastErrorCode: null,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      const attempts = delivery.attempts + 1;
      const dead = isTerminalAttempt(attempts, EMAIL_MAX_ATTEMPTS);
      await this.prisma.emailDelivery.update({
        where: { id: deliveryId },
        data: {
          status: dead ? 'DEAD' : 'FAILED',
          lastErrorCode: 'SMTP_ERROR',
          nextAttemptAt: nextAttemptAt(attempts),
          updatedAt: new Date(),
        },
      });
      if (dead) {
        await writeAuditLog(this.prisma, {
          actor: null,
          action: 'EMAIL_DELIVERY_EXHAUSTED',
          entityType: 'EMAIL_DELIVERY',
          entityId: deliveryId,
          newValue: toJsonValue({ status: 'DEAD' }),
          source: 'SYSTEM',
        });
        return;
      }
      throw error;
    }
  }

  async evaluateDaily(): Promise<void> {
    const businessDate = calendarDateInTimeZone(new Date());
    const settings = await this.prisma.systemSettings.findUnique({ where: { id: 'default' } });
    const warningDays = settings?.deadlineWarningDays ?? 3;
    const thresholds = settings?.escalationDays?.length ? settings.escalationDays : [0, 3, 7, 14];
    const [contractorPool, managers, admins] = await Promise.all([
      this.activeIds('CONTRACTOR_ENGINEER'),
      this.activeIds('SGR_MANAGER'),
      this.activeIds('ADMIN'),
    ]);
    let cursor: string | undefined;
    let processed = 0;
    for (;;) {
      const batch = await this.prisma.defectItem.findMany({
        where: {
          status: 'IN_PROGRESS',
          act: { status: { not: 'CANCELLED' } },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 100,
        include: { responsibleEngineers: true },
      });
      if (batch.length === 0) {
        break;
      }
      for (const item of batch) {
        cursor = item.id;
        processed += 1;
        const clocks = await this.ensureClocks(item, warningDays);
        for (const clock of clocks) {
          if (
            clock.state === 'COMPLETED' ||
            clock.state === 'NO_DEADLINE' ||
            clock.state === 'NORMAL'
          ) {
            continue;
          }
          const assigned = item.responsibleEngineers.map((row) => row.userId);
          if (clock.state === 'WARNING') {
            await this.enqueueSla(item, clock, 'SLA_WARNING', null, businessDate, {
              assigned,
              contractors: contractorPool,
              managers,
              admins,
            });
          }
          const overdueDays = overdueDaysOf({ deadline: clock.deadline });
          for (const threshold of reachedEscalationThresholds(overdueDays, thresholds)) {
            const type = threshold === 0 ? 'SLA_DUE_TODAY' : 'SLA_OVERDUE';
            await this.enqueueSla(item, clock, type, threshold, businessDate, {
              assigned,
              contractors: contractorPool,
              managers,
              admins,
            });
          }
        }
      }
      if (batch.length < 100) {
        break;
      }
    }
    await this.prisma.slaEvaluationState.upsert({
      where: { id: 'default' },
      update: {
        lastSuccessfulBusinessDate: businessDate,
        lastRunAt: new Date(),
        lastStatus: 'OK',
        lastErrorCode: null,
        updatedAt: new Date(),
      },
      create: {
        id: 'default',
        lastSuccessfulBusinessDate: businessDate,
        lastRunAt: new Date(),
        lastStatus: 'OK',
        updatedAt: new Date(),
      },
    });
    await writeAuditLog(this.prisma, {
      actor: null,
      action: 'SLA_EVALUATION_COMPLETED',
      entityType: 'SLA_EVALUATION',
      entityId: 'default',
      newValue: toJsonValue({ businessDate, processed }),
      source: 'SYSTEM',
    });
  }

  async recover(): Promise<void> {
    const pending = await this.prisma.outboxEvent.findMany({
      where: { status: { in: ['PENDING', 'FAILED'] }, availableAt: { lte: new Date() } },
      take: 50,
      orderBy: { availableAt: 'asc' },
    });
    for (const row of pending) {
      try {
        await this.queue.add(
          OUTBOX_DISPATCH_JOB,
          { outboxId: row.id },
          { jobId: outboxJobId(row.id) },
        );
      } catch (error) {
        this.logger.warn(
          `Outbox recover deferred id=${row.id} code=${error instanceof Error ? error.name : 'ENQUEUE_FAILED'}`,
        );
      }
    }
    const emails = await this.prisma.emailDelivery.findMany({
      where: { status: { in: ['QUEUED', 'FAILED'] }, nextAttemptAt: { lte: new Date() } },
      take: 50,
    });
    for (const row of emails) {
      try {
        await this.queue.add(
          EMAIL_DELIVER_JOB,
          { deliveryId: row.id },
          { jobId: emailJobId(row.id) },
        );
      } catch (error) {
        this.logger.warn(
          `Email recover deferred id=${row.id} code=${error instanceof Error ? error.name : 'ENQUEUE_FAILED'}`,
        );
      }
    }
    const state = await this.prisma.slaEvaluationState.findUnique({ where: { id: 'default' } });
    const today = calendarDateInTimeZone(new Date());
    if (state?.lastSuccessfulBusinessDate !== today) {
      try {
        await this.queue.add(
          SLA_EVALUATE_JOB,
          { reason: 'catch-up' },
          { jobId: slaCatchUpJobId(today) },
        );
      } catch (error) {
        this.logger.warn(
          `SLA catch-up enqueue deferred code=${error instanceof Error ? error.name : 'ENQUEUE_FAILED'}`,
        );
      }
    }
  }

  async smtpStatus(): Promise<{ status: 'up' | 'down' | 'disabled'; latencyMs?: number }> {
    const config = loadConfig();
    const settings = await this.prisma.systemSettings.findUnique({ where: { id: 'default' } });
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

  async stats() {
    const [pending, oldest, emailQueued, emailFailed, emailDead, sla, settings] = await Promise.all(
      [
        this.prisma.outboxEvent.count({
          where: { status: { in: ['PENDING', 'CLAIMED', 'FAILED'] } },
        }),
        this.prisma.outboxEvent.findFirst({
          where: { status: { in: ['PENDING', 'FAILED'] } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        this.prisma.emailDelivery.count({ where: { status: { in: ['QUEUED', 'SENDING'] } } }),
        this.prisma.emailDelivery.count({ where: { status: 'FAILED' } }),
        this.prisma.emailDelivery.count({ where: { status: 'DEAD' } }),
        this.prisma.slaEvaluationState.findUnique({ where: { id: 'default' } }),
        this.prisma.systemSettings.findUnique({ where: { id: 'default' } }),
      ],
    );
    const counts = await this.queue.getJobCounts();
    const smtp = await this.smtpStatus();
    return {
      outboxPending: pending,
      oldestPendingOutboxAgeMs: oldest ? Date.now() - oldest.createdAt.getTime() : null,
      emailQueued,
      emailFailed,
      emailDead,
      lastSlaBusinessDate: sla?.lastSuccessfulBusinessDate ?? null,
      lastSlaRunAt: sla?.lastRunAt?.toISOString() ?? null,
      nextSlaRunAt: nextDailyEvaluationAt(
        settings?.dailyEvaluationMinuteOfDay ?? 480,
      ).toISOString(),
      smtp,
      queue: {
        waiting: counts.waiting,
        active: counts.active,
        failed: counts.failed,
        delayed: counts.delayed,
      },
    };
  }

  private async enqueueSla(
    item: { id: string; actId: string },
    clock: { kind: SlaClockKind; cycle: number; deadline: Date | null; state: string },
    type: NotificationType,
    threshold: number | null,
    businessDate: string,
    pools: {
      assigned: string[];
      contractors: string[];
      managers: string[];
      admins: string[];
    },
  ): Promise<void> {
    const occurrenceBase = buildOccurrenceKey([
      type,
      clock.kind,
      item.id,
      clock.cycle,
      threshold ?? 'warning',
    ]);
    const existing = await this.prisma.notificationEvent.findUnique({
      where: { occurrenceKey: occurrenceBase },
    });
    if (existing) {
      return;
    }
    if (process.env.SLA_EVALUATOR_DRY_RUN === 'true') {
      return;
    }
    const ids = await this.prisma.$transaction(async (tx) => {
      const outboxId = randomUUID();
      await tx.outboxEvent.create({
        data: {
          id: outboxId,
          type,
          payload: {
            type,
            occurrenceBase,
            actId: item.actId,
            defectItemId: item.id,
            automatic: true,
            kind: clock.kind,
            cycle: clock.cycle,
            threshold,
            businessDate,
            deadline: clock.deadline ? calendarDateInTimeZone(clock.deadline) : null,
            body: notificationTitle(type),
            extraRecipientIds: recipientsForDeadlineAlert({
              kind: clock.kind,
              threshold,
              assignedResponsibleIds: pools.assigned,
              contractorIds: pools.contractors,
              sgrManagerIds: pools.managers,
              adminIds: pools.admins,
            }),
          },
          updatedAt: new Date(),
        },
      });
      return [outboxId];
    });
    for (const id of ids) {
      try {
        await this.queue.add(OUTBOX_DISPATCH_JOB, { outboxId: id }, { jobId: outboxJobId(id) });
      } catch (error) {
        this.logger.warn(
          `SLA outbox enqueue deferred id=${id} code=${error instanceof Error ? error.name : 'ENQUEUE_FAILED'}`,
        );
      }
    }
  }

  private async ensureClocks(
    item: {
      id: string;
      status: 'IN_PROGRESS' | 'COMPLETED';
      claimDeadline: Date | null;
      plannedDeadline: Date | null;
      thirdPartyDeadline: Date | null;
    },
    warningDays: number,
  ) {
    const { syncSlaClocks } = await import('./outbox.writer');
    await this.prisma.$transaction(async (tx) => {
      await syncSlaClocks(tx, item, warningDays);
    });
    return this.prisma.slaClock.findMany({ where: { defectItemId: item.id } });
  }

  private async resolveRecipients(payload: OutboxPayload): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: payload.extraRecipientIds ?? [] }, status: 'ACTIVE' },
      select: { id: true },
    });
    return suppressActorRecipients(
      users.map((row) => row.id),
      payload.actorUserId,
      { automatic: payload.automatic === true },
    );
  }

  private async activeIds(
    role: 'ADMIN' | 'SGR_MANAGER' | 'RESPONSIBLE_ENGINEER' | 'CONTRACTOR_ENGINEER',
  ) {
    const rows = await this.prisma.user.findMany({
      where: { role, status: 'ACTIVE' },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  private async claim(outboxId: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        type: string;
        payload: unknown;
        attempts: number;
      }>
    >(Prisma.sql`
      UPDATE "outbox_events"
      SET status = 'CLAIMED', "claimedAt" = NOW(), "claimedBy" = ${`worker-${process.pid}`},
          attempts = attempts + 1, "updatedAt" = NOW()
      WHERE id = ${outboxId}
        AND status IN ('PENDING', 'FAILED')
        AND "availableAt" <= NOW()
      RETURNING id, type, payload, attempts
    `);
    return rows[0] ?? null;
  }

  private async markProcessed(id: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { status: 'PROCESSED', processedAt: new Date(), updatedAt: new Date() },
    });
  }
}

async function sendMail(
  config: AppConfig,
  to: string,
  mail: { subject: string; text: string; html: string },
): Promise<{ messageId: string }> {
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth:
      config.SMTP_USER && config.SMTP_PASSWORD
        ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
        : undefined,
    connectionTimeout: 4000,
    greetingTimeout: 4000,
    socketTimeout: 4000,
  });
  try {
    const info = await transporter.sendMail({
      from: config.EMAIL_FROM,
      to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return { messageId: String(info.messageId ?? '') };
  } finally {
    transporter.close();
  }
}

@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(NotificationProcessor.name);
  private readonly prisma: PrismaClient;

  constructor(
    @Inject(NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
    @InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue,
  ) {
    super();
    this.prisma = getPrismaClient(loadConfig().DATABASE_URL);
  }

  async onModuleInit(): Promise<void> {
    void this.scheduleJobs().catch((error) => {
      this.logger.warn(
        `Notification schedule deferred code=${error instanceof Error ? error.name : 'SCHEDULE_FAILED'}`,
      );
    });
  }

  private async scheduleJobs(): Promise<void> {
    const settings = await this.prisma.systemSettings.findUnique({
      where: { id: 'default' },
    });
    const minute = settings?.dailyEvaluationMinuteOfDay ?? 480;
    const hour = Math.floor(minute / 60);
    const mins = minute % 60;
    await this.queue.add(
      SLA_EVALUATE_JOB,
      { reason: 'schedule' },
      {
        repeat: { pattern: `${mins} ${hour} * * *`, tz: 'Europe/Minsk' },
        jobId: 'sla.evaluate-daily',
      },
    );
    const existing = await this.queue.getJob('outbox.recover-startup');
    const busy =
      existing &&
      ((await existing.isActive()) || (await existing.isWaiting()) || (await existing.isDelayed()));
    if (!busy) {
      await this.queue.add(
        OUTBOX_RECOVERY_JOB,
        { reason: 'startup' },
        { jobId: 'outbox.recover-startup', removeOnComplete: true },
      );
    }
  }

  async process(job: Job<{ outboxId?: string; deliveryId?: string }>): Promise<{ ok: boolean }> {
    if (job.name === OUTBOX_RECOVERY_JOB) {
      await this.dispatcher.recover();
      return { ok: true };
    }
    if (job.name === SLA_EVALUATE_JOB) {
      try {
        await this.dispatcher.evaluateDaily();
      } catch (error) {
        await writeAuditLog(this.prisma, {
          actor: null,
          action: 'SLA_EVALUATION_FAILED',
          entityType: 'SLA_EVALUATION',
          entityId: 'default',
          newValue: toJsonValue({ error: 'EVALUATION_FAILED' }),
          source: 'SYSTEM',
        });
        throw error;
      }
      return { ok: true };
    }
    if (job.name === OUTBOX_DISPATCH_JOB && job.data.outboxId) {
      await this.dispatcher.dispatch(job.data.outboxId);
      return { ok: true };
    }
    if (job.name === EMAIL_DELIVER_JOB && job.data.deliveryId) {
      await this.dispatcher.deliver(job.data.deliveryId);
      return { ok: true };
    }
    return { ok: true };
  }
}
