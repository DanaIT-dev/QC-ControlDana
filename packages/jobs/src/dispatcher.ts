import { randomUUID } from 'node:crypto';
import { createConnection, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { loadConfig, redisTlsOptions, type AppConfig } from '@sgr-registry/config';
import type { PrismaClient } from '@sgr-registry/database';
import { Prisma, insertOutboxEventRow } from '@sgr-registry/database';
import {
  EMAIL_DELIVER_JOB,
  EMAIL_MAX_ATTEMPTS,
  OUTBOX_CLAIM_LEASE_MS,
  OUTBOX_DISPATCH_JOB,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RECOVERY_JOB,
  SLA_EVALUATE_JOB,
  assertSafeNotificationPayload,
  buildActUrl,
  buildOccurrenceKey,
  calendarDateInTimeZone,
  classifySmtpError,
  emailJobId,
  emailLeaseMs,
  emailMessageId,
  isTerminalAttempt,
  nextAttemptAt,
  notificationTitle,
  outboxJobId,
  overdueDaysOf,
  reachedEscalationThresholds,
  recipientsForDeadlineAlert,
  redactTransportSecrets,
  renderNotificationEmail,
  resolveSlaEvaluationLockKey,
  slaCatchUpJobId,
  suppressActorRecipients,
  nextDailyEvaluationAt,
  type NotificationType,
  type SlaClockKind,
  type SmtpErrorCode,
} from '@sgr-registry/domain';
import nodemailer from 'nodemailer';
import { Redis } from 'ioredis';
import { writeAuditLog, toJsonValue } from './audit-writer.js';

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
  organizationId?: string | null;
  missingFields?: string[] | null;
};

export type WorkerDbRunner = <T>(callback: () => Promise<T>) => Promise<T>;

type ClaimedOutbox = {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
};

type ClaimedEmail = {
  deliveryId: string;
  attempts: number;
  to: string;
  title: string;
  body: string;
  actId: string;
  defectItemId: string | null;
};

export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly queue: Queue,
    private readonly runDb: WorkerDbRunner = (callback) => callback(),
  ) {}

  async dispatch(outboxId: string): Promise<void> {
    const result = await this.runDb(() => this.dispatchInTx(outboxId));
    if (!result) {
      return;
    }
    for (const deliveryId of result.deliveryIds) {
      await this.enqueueEmailJob(deliveryId);
    }
  }

  async deliver(deliveryId: string): Promise<void> {
    const config = loadConfig();
    const claimed = await this.runDb(() => this.claimEmail(deliveryId, config));
    if (!claimed) {
      return;
    }
    const messageId = emailMessageId(claimed.deliveryId, config.EMAIL_FROM);
    const mail = renderNotificationEmail({
      title: claimed.title,
      body: claimed.body,
      actUrl: buildActUrl(config.PUBLIC_APP_URL, claimed.actId, claimed.defectItemId ?? undefined),
    });
    try {
      await sendMail(config, claimed.to, mail, messageId);
      await this.runDb(() => this.markEmailSent(claimed.deliveryId, messageId));
    } catch (error) {
      const classified = classifySmtpError(error);
      const dead = await this.runDb(() =>
        this.markEmailFailure(
          claimed.deliveryId,
          claimed.attempts,
          classified.code,
          classified.retryable,
        ),
      );
      this.logger.warn(`email delivery ${classified.code}`);
      if (!dead && classified.retryable) {
        throw error;
      }
    }
  }

  async evaluateDaily(): Promise<void> {
    const businessDate = calendarDateInTimeZone(new Date());
    const lockKey = resolveSlaEvaluationLockKey(businessDate);
    const lockRedis = new Redis(loadConfig().WORKER_REDIS_URL, {
      ...redisTlsOptions(loadConfig().WORKER_REDIS_URL),
      maxRetriesPerRequest: 1,
    });
    try {
      const locked = await lockRedis.set(lockKey, String(process.pid), 'EX', 180, 'NX');
      if (locked !== 'OK') {
        return;
      }
      try {
        await this.runDailyEvaluation(businessDate);
      } finally {
        await lockRedis.del(lockKey).catch(() => undefined);
      }
    } finally {
      lockRedis.disconnect();
    }
  }

  async recover(): Promise<void> {
    const snapshot = await this.runDb(async () => {
      const pending = await this.prisma.outboxEvent.findMany({
        where: {
          status: { in: ['PENDING', 'FAILED', 'CLAIMED'] },
          availableAt: { lte: new Date() },
        },
        take: 50,
        orderBy: { availableAt: 'asc' },
        select: { id: true },
      });
      const emails = await this.prisma.emailDelivery.findMany({
        where: {
          status: { in: ['QUEUED', 'FAILED', 'SENDING'] },
          nextAttemptAt: { lte: new Date() },
        },
        take: 50,
        select: { id: true },
      });
      const state = await this.prisma.slaEvaluationState.findUnique({ where: { id: 'default' } });
      const today = calendarDateInTimeZone(new Date());
      return {
        pending: pending.map((row) => row.id),
        emails: emails.map((row) => row.id),
        needSla: state?.lastSuccessfulBusinessDate !== today,
      };
    });
    for (const id of snapshot.pending) {
      await this.enqueueOutboxJob(id);
    }
    for (const id of snapshot.emails) {
      await this.enqueueEmailJob(id);
    }
    if (snapshot.needSla) {
      try {
        await this.queue.add(
          SLA_EVALUATE_JOB,
          { reason: 'catch-up' },
          { jobId: slaCatchUpJobId(calendarDateInTimeZone(new Date())) },
        );
      } catch (error) {
        this.logger.warn(`SLA catch-up enqueue deferred code=${errorName(error)}`);
      }
    }
  }

  async smtpStatus(): Promise<{ status: 'up' | 'down' | 'disabled'; latencyMs?: number }> {
    const config = loadConfig();
    const enabled = await this.runDb(async () => {
      const settings = await this.prisma.systemSettings.findUnique({ where: { id: 'default' } });
      return config.EMAIL_ENABLED && settings?.emailEnabled !== false;
    });
    if (!enabled) {
      return { status: 'disabled' };
    }
    return probeSmtpTransport(config);
  }

  async stats() {
    const [pending, oldest, emailQueued, emailFailed, emailDead, sla, settings] = await this.runDb(
      () =>
        Promise.all([
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
        ]),
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

  async recordSlaFailure(): Promise<void> {
    await this.runDb(async () => {
      await writeAuditLog(this.prisma, {
        actor: null,
        action: 'SLA_EVALUATION_FAILED',
        entityType: 'SLA_EVALUATION',
        entityId: 'default',
        newValue: toJsonValue({ error: 'EVALUATION_FAILED' }),
        source: 'SYSTEM',
      });
    });
  }

  private async dispatchInTx(outboxId: string): Promise<{ deliveryIds: string[] } | null> {
    const claimed = await this.claimOutbox(outboxId);
    if (!claimed) {
      return null;
    }
    try {
      const payload = claimed.payload as OutboxPayload;
      assertSafeNotificationPayload(payload);
      if (payload.type === 'ACT_CHAT_MENTION') {
        await this.markProcessed(claimed.id);
        return { deliveryIds: [] };
      }
      const clockBound =
        payload.type.startsWith('SLA_') ||
        payload.type === 'EFFECTIVE_DEADLINE_CHANGED' ||
        payload.type === 'THIRD_PARTY_DEADLINE_CHANGED';
      if (
        clockBound &&
        payload.kind &&
        payload.cycle !== undefined &&
        payload.deadline !== undefined
      ) {
        if (!payload.defectItemId) {
          await this.markProcessed(claimed.id);
          return { deliveryIds: [] };
        }
        const clock = await this.prisma.slaClock.findUnique({
          where: {
            defectItemId_kind: { defectItemId: payload.defectItemId, kind: payload.kind },
          },
        });
        const current = clock?.deadline ? calendarDateInTimeZone(clock.deadline) : null;
        if (!clock || clock.cycle !== payload.cycle || current !== (payload.deadline ?? null)) {
          await this.markProcessed(claimed.id);
          return { deliveryIds: [] };
        }
        if (clock.state === 'COMPLETED' && payload.type.startsWith('SLA_')) {
          await this.markProcessed(claimed.id);
          return { deliveryIds: [] };
        }
      }
      const recipientIds = await this.resolveRecipients(payload);
      if (recipientIds.length === 0) {
        await this.markProcessed(claimed.id);
        return { deliveryIds: [] };
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
            organizationId: payload.organizationId ?? null,
            missingFields: payload.missingFields ?? null,
          },
          occurredAt: new Date(),
        },
      });
      const deliveryIds: string[] = [];
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
        const skipEmail = payload.type === 'ORGANIZATION_DETAILS_INCOMPLETE';
        const delivery = skipEmail
          ? null
          : await this.prisma.emailDelivery.upsert({
              where: { notificationRecipientId: recipient.id },
              update: {},
              create: {
                id: randomUUID(),
                notificationRecipientId: recipient.id,
                updatedAt: new Date(),
              },
            });
        if (delivery && (delivery.status === 'QUEUED' || delivery.status === 'FAILED')) {
          deliveryIds.push(delivery.id);
        }
      }
      await this.markProcessed(claimed.id);
      return { deliveryIds };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2003' || error.code === 'P2025')
      ) {
        await this.markProcessed(claimed.id);
        return { deliveryIds: [] };
      }
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
        return { deliveryIds: [] };
      }
      this.logger.warn(
        redactTransportSecrets(error instanceof Error ? error.message : 'dispatch failed'),
      );
      throw error;
    }
  }

  private async runDailyEvaluation(businessDate: string): Promise<void> {
    const prelude = await this.runDb(async () => {
      const settings = await this.prisma.systemSettings.findUnique({ where: { id: 'default' } });
      const warningDays = settings?.deadlineWarningDays ?? 3;
      const thresholds = settings?.escalationDays?.length ? settings.escalationDays : [0, 3, 7, 14];
      const [managers, admins, orgManagers] = await Promise.all([
        this.activeIds('SGR_MANAGER'),
        this.activeIds('ADMIN'),
        this.activeIds('MANAGER'),
      ]);
      return {
        warningDays,
        thresholds,
        managers,
        admins: [...admins, ...orgManagers],
      };
    });
    let cursor: string | undefined;
    let processed = 0;
    for (;;) {
      const batch = await this.runDb(async () => {
        const items = await this.prisma.defectItem.findMany({
          where: {
            status: { in: ['IN_PROGRESS', 'PENDING_INSPECTION'] },
            act: {
              status: { notIn: ['CANCELLED', 'IMPORTED_UNSPECIFIED'] },
              startedAt: { not: null },
            },
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: 100,
          include: {
            responsibleEngineers: true,
            liableOrganizations: { select: { organizationId: true } },
          },
        });
        const organizationIds = [
          ...new Set(
            items.flatMap((item) => item.liableOrganizations.map((row) => row.organizationId)),
          ),
        ];
        const memberships =
          organizationIds.length === 0
            ? []
            : await this.prisma.userOrganizationMembership.findMany({
                where: {
                  organizationId: { in: organizationIds },
                  revokedAt: null,
                  user: { role: 'CONTRACTOR_ENGINEER', status: 'ACTIVE' },
                },
                select: { userId: true, organizationId: true },
              });
        const outboxIds: string[] = [];
        for (const item of items) {
          processed += 1;
          const clocks = await this.ensureClocks(item, prelude.warningDays);
          for (const clock of clocks) {
            if (
              clock.state === 'COMPLETED' ||
              clock.state === 'NO_DEADLINE' ||
              clock.state === 'NORMAL'
            ) {
              continue;
            }
            const assigned = item.responsibleEngineers.map((row) => row.userId);
            const orgIds = new Set(item.liableOrganizations.map((row) => row.organizationId));
            const contractors = [
              ...new Set(
                memberships
                  .filter((row) => orgIds.has(row.organizationId))
                  .map((row) => row.userId),
              ),
            ];
            if (clock.state === 'WARNING') {
              const id = await this.enqueueSla(item, clock, 'SLA_WARNING', null, businessDate, {
                assigned,
                contractors,
                managers: prelude.managers,
                admins: prelude.admins,
              });
              if (id) {
                outboxIds.push(id);
              }
            }
            const overdueDays = overdueDaysOf({ deadline: clock.deadline });
            for (const threshold of reachedEscalationThresholds(overdueDays, prelude.thresholds)) {
              const type = threshold === 0 ? 'SLA_DUE_TODAY' : 'SLA_OVERDUE';
              const id = await this.enqueueSla(item, clock, type, threshold, businessDate, {
                assigned,
                contractors,
                managers: prelude.managers,
                admins: prelude.admins,
              });
              if (id) {
                outboxIds.push(id);
              }
            }
          }
        }
        return {
          outboxIds,
          nextCursor: items.at(-1)?.id,
          done: items.length < 100,
        };
      });
      for (const id of batch.outboxIds) {
        await this.enqueueOutboxJob(id);
      }
      if (batch.done) {
        break;
      }
      cursor = batch.nextCursor;
    }
    await this.runDb(async () => {
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
    });
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
  ): Promise<string | null> {
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
      return null;
    }
    if (process.env.SLA_EVALUATOR_DRY_RUN === 'true') {
      return null;
    }
    const outboxId = randomUUID();
    await insertOutboxEventRow(this.prisma, {
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
    });
    return outboxId;
  }

  private async ensureClocks(
    item: {
      id: string;
      status: 'IN_PROGRESS' | 'PENDING_INSPECTION' | 'COMPLETED';
      claimDeadline: Date | null;
      plannedDeadline: Date | null;
      thirdPartyDeadline: Date | null;
    },
    warningDays: number,
  ) {
    const { syncSlaClocks } = await import('./outbox.writer.js');
    await syncSlaClocks(this.prisma, item, warningDays);
    return this.prisma.slaClock.findMany({ where: { defectItemId: item.id } });
  }

  private async resolveRecipients(payload: OutboxPayload): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: payload.extraRecipientIds ?? [] },
        status: 'ACTIVE',
        role: { not: 'SUPER_ADMIN' },
      },
      select: { id: true },
    });
    return suppressActorRecipients(
      users.map((row) => row.id),
      payload.actorUserId,
      { automatic: payload.automatic === true },
    );
  }

  private async activeIds(
    role: 'ADMIN' | 'MANAGER' | 'SGR_MANAGER' | 'RESPONSIBLE_ENGINEER' | 'CONTRACTOR_ENGINEER',
  ) {
    const rows = await this.prisma.user.findMany({
      where: { role, status: 'ACTIVE' },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  private async claimOutbox(outboxId: string): Promise<ClaimedOutbox | null> {
    const rows = await this.prisma.$queryRaw<ClaimedOutbox[]>(Prisma.sql`
      UPDATE "outbox_events"
      SET status = 'CLAIMED',
          "claimedAt" = NOW(),
          "claimedBy" = ${`worker-${process.pid}`},
          attempts = attempts + 1,
          "availableAt" = NOW() + (${OUTBOX_CLAIM_LEASE_MS} * INTERVAL '1 millisecond'),
          "updatedAt" = NOW()
      WHERE id = ${outboxId}::uuid
        AND (
          (status IN ('PENDING', 'FAILED') AND "availableAt" <= NOW())
          OR (status = 'CLAIMED' AND "availableAt" <= NOW())
        )
      RETURNING id, type, payload, attempts
    `);
    return rows[0] ?? null;
  }

  private async claimEmail(deliveryId: string, config: AppConfig): Promise<ClaimedEmail | null> {
    const leaseMs = emailLeaseMs(config.SMTP_TIMEOUT_MS);
    const rows = await this.prisma.$queryRaw<Array<{ id: string; attempts: number }>>(Prisma.sql`
      UPDATE "email_deliveries"
      SET status = 'SENDING',
          attempts = attempts + 1,
          "nextAttemptAt" = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
          "updatedAt" = NOW()
      WHERE id = ${deliveryId}::uuid
        AND (
          (status = 'QUEUED' AND "nextAttemptAt" <= NOW())
          OR status = 'FAILED'
          OR (status = 'SENDING' AND "nextAttemptAt" <= NOW())
        )
      RETURNING id, attempts
    `);
    const claimed = rows[0];
    if (!claimed) {
      return null;
    }
    const delivery = await this.prisma.emailDelivery.findUnique({
      where: { id: claimed.id },
      include: { recipient: { include: { event: true, user: true } } },
    });
    if (!delivery) {
      return null;
    }
    if (delivery.recipient.revokedAt || delivery.recipient.user.status === 'ARCHIVED') {
      await this.prisma.emailDelivery.update({
        where: { id: claimed.id },
        data: { status: 'DEAD', lastErrorCode: 'REVOKED', updatedAt: new Date() },
      });
      return null;
    }
    const settings = await this.prisma.systemSettings.findUnique({ where: { id: 'default' } });
    if (!config.EMAIL_ENABLED || settings?.emailEnabled === false) {
      await this.prisma.emailDelivery.update({
        where: { id: claimed.id },
        data: {
          status: 'QUEUED',
          lastErrorCode: 'EMAIL_DISABLED',
          nextAttemptAt: new Date(),
          updatedAt: new Date(),
        },
      });
      return null;
    }
    const actId = delivery.recipient.event.actId;
    if (!actId) {
      await this.prisma.emailDelivery.update({
        where: { id: claimed.id },
        data: { status: 'DEAD', lastErrorCode: 'NO_ACT', updatedAt: new Date() },
      });
      return null;
    }
    const payload = delivery.recipient.event.payload as { title?: string; body?: string };
    return {
      deliveryId: claimed.id,
      attempts: claimed.attempts,
      to: delivery.recipient.user.email,
      title: payload.title ?? notificationTitle(delivery.recipient.event.type as NotificationType),
      body: payload.body ?? notificationTitle(delivery.recipient.event.type as NotificationType),
      actId,
      defectItemId: delivery.recipient.event.defectItemId,
    };
  }

  private async markEmailSent(deliveryId: string, messageId: string): Promise<void> {
    await this.prisma.emailDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        providerMessageId: messageId,
        lastErrorCode: null,
        updatedAt: new Date(),
      },
    });
  }

  private async markEmailFailure(
    deliveryId: string,
    attempts: number,
    code: SmtpErrorCode,
    retryable: boolean,
  ): Promise<boolean> {
    const dead = !retryable || isTerminalAttempt(attempts, EMAIL_MAX_ATTEMPTS);
    await this.prisma.emailDelivery.update({
      where: { id: deliveryId },
      data: {
        status: dead ? 'DEAD' : 'FAILED',
        lastErrorCode: code,
        nextAttemptAt: dead ? new Date() : nextAttemptAt(attempts),
        updatedAt: new Date(),
      },
    });
    if (dead) {
      await writeAuditLog(this.prisma, {
        actor: null,
        action: 'EMAIL_DELIVERY_EXHAUSTED',
        entityType: 'EMAIL_DELIVERY',
        entityId: deliveryId,
        newValue: toJsonValue({ status: 'DEAD', code }),
        source: 'SYSTEM',
      });
    }
    return dead;
  }

  private async markProcessed(id: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { status: 'PROCESSED', processedAt: new Date(), updatedAt: new Date() },
    });
  }

  private async enqueueOutboxJob(outboxId: string): Promise<void> {
    try {
      await this.queue.add(OUTBOX_DISPATCH_JOB, { outboxId }, { jobId: outboxJobId(outboxId) });
    } catch (error) {
      this.logger.warn(`Outbox enqueue deferred id=${outboxId} code=${errorName(error)}`);
    }
  }

  private async enqueueEmailJob(deliveryId: string): Promise<void> {
    try {
      await this.queue.add(
        EMAIL_DELIVER_JOB,
        { deliveryId },
        {
          jobId: emailJobId(deliveryId),
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        },
      );
    } catch (error) {
      this.logger.warn(`Email enqueue deferred id=${deliveryId} code=${errorName(error)}`);
    }
  }
}

export async function probeSmtpTransport(
  config: AppConfig = loadConfig(),
): Promise<{ status: 'up' | 'down' | 'disabled'; latencyMs?: number }> {
  if (!config.EMAIL_ENABLED) {
    return { status: 'disabled' };
  }
  const started = Date.now();
  const timeout = Math.min(config.SMTP_TIMEOUT_MS, 2_000);
  try {
    await withSmtpConnectRetry(async () => {
      await withOwnedSmtpSocket(config, timeout, async (socket) => {
        const transporter = smtpTransport(config, timeout, socket);
        try {
          await transporter.verify();
        } finally {
          transporter.close();
        }
      });
    });
    return { status: 'up', latencyMs: Date.now() - started };
  } catch {
    return { status: 'down', latencyMs: Date.now() - started };
  }
}

function smtpTransport(config: AppConfig, timeoutMs: number, connection?: Socket) {
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    name: 'localhost',
    auth:
      config.SMTP_USER && config.SMTP_PASSWORD
        ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
        : undefined,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    ...(connection ? { connection, secured: config.SMTP_SECURE } : {}),
  });
}

function openSmtpSocket(config: AppConfig, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = config.SMTP_SECURE
      ? tlsConnect({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          servername: config.SMTP_HOST,
        })
      : createConnection({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          family: isIP(config.SMTP_HOST) === 6 ? 6 : 4,
        });
    const timer = setTimeout(() => {
      socket.destroy();
      const error = new Error('Timeout');
      Object.assign(error, { code: 'ETIMEDOUT', command: 'CONN' });
      reject(error);
    }, timeoutMs);
    const onError = (error: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const onReady = (): void => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(socket);
    };
    socket.once(config.SMTP_SECURE ? 'secureConnect' : 'connect', onReady);
    socket.once('error', onError);
  });
}

async function withOwnedSmtpSocket<T>(
  config: AppConfig,
  timeoutMs: number,
  operation: (socket: Socket) => Promise<T>,
): Promise<T> {
  const socket = await openSmtpSocket(config, timeoutMs);
  try {
    return await operation(socket);
  } finally {
    if (!socket.destroyed) {
      socket.destroy();
    }
  }
}

function isRetryableSmtpConnectError(error: unknown): boolean {
  const err = error as { command?: string };
  if (err.command && err.command !== 'CONN') {
    return false;
  }
  const classified = classifySmtpError(error);
  return classified.code === 'SMTP_TIMEOUT' || classified.code === 'SMTP_CONNECTION';
}

async function withSmtpConnectRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === 3 || !isRetryableSmtpConnectError(error)) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function sendMail(
  config: AppConfig,
  to: string,
  mail: { subject: string; text: string; html: string },
  messageId: string,
): Promise<void> {
  await withSmtpConnectRetry(async () => {
    await withOwnedSmtpSocket(config, config.SMTP_TIMEOUT_MS, async (socket) => {
      const transporter = smtpTransport(config, config.SMTP_TIMEOUT_MS, socket);
      try {
        await transporter.sendMail({
          from: config.EMAIL_FROM,
          to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          messageId: `<${messageId.replace(/[<>]/g, '')}>`,
        });
      } finally {
        transporter.close();
      }
    });
  });
}

function errorName(error: unknown): string {
  return redactTransportSecrets(error instanceof Error ? error.name : 'ENQUEUE_FAILED');
}

export async function processNotificationJob(
  dispatcher: NotificationDispatcher,
  _prisma: PrismaClient,
  job: Job<{ outboxId?: string; deliveryId?: string }>,
): Promise<{ ok: boolean }> {
  if (job.name === OUTBOX_RECOVERY_JOB) {
    await dispatcher.recover();
    return { ok: true };
  }
  if (job.name === SLA_EVALUATE_JOB) {
    try {
      await dispatcher.evaluateDaily();
    } catch (error) {
      await dispatcher.recordSlaFailure();
      throw error;
    }
    return { ok: true };
  }
  if (job.name === OUTBOX_DISPATCH_JOB && job.data.outboxId) {
    await dispatcher.dispatch(job.data.outboxId);
    return { ok: true };
  }
  if (job.name === EMAIL_DELIVER_JOB && job.data.deliveryId) {
    await dispatcher.deliver(job.data.deliveryId);
    return { ok: true };
  }
  return { ok: true };
}

export async function scheduleNotificationJobs(
  prisma: PrismaClient,
  queue: Queue,
  runDb: WorkerDbRunner = (callback) => callback(),
): Promise<void> {
  const settings = await runDb(() =>
    prisma.systemSettings.findUnique({
      where: { id: 'default' },
    }),
  );
  const minute = settings?.dailyEvaluationMinuteOfDay ?? 480;
  const hour = Math.floor(minute / 60);
  const mins = minute % 60;
  await queue.add(
    SLA_EVALUATE_JOB,
    { reason: 'schedule' },
    {
      repeat: { pattern: `${mins} ${hour} * * *`, tz: 'Europe/Minsk' },
      jobId: 'sla.evaluate-daily',
    },
  );
  const existing = await queue.getJob('outbox.recover-startup');
  const busy =
    existing &&
    ((await existing.isActive()) || (await existing.isWaiting()) || (await existing.isDelayed()));
  if (!busy) {
    await queue.add(
      OUTBOX_RECOVERY_JOB,
      { reason: 'startup' },
      { jobId: 'outbox.recover-startup', removeOnComplete: true },
    );
  }
}
