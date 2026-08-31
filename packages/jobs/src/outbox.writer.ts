import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Prisma, insertOutboxEventRow } from '@sgr-registry/database';
import {
  OUTBOX_DISPATCH_JOB,
  assertSafeNotificationPayload,
  calendarDateInTimeZone,
  nextClockCycle,
  outboxJobId,
  resolveNotificationQueueName,
  slaStateOf,
  type SlaClockKind,
} from '@sgr-registry/domain';

export const NOTIFICATION_QUEUE = resolveNotificationQueueName();

export type OutboxTx = {
  $executeRaw: Prisma.TransactionClient['$executeRaw'];
};

@Injectable()
export class OutboxWriter {
  private readonly logger = new Logger(OutboxWriter.name);

  constructor(@InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue) {}

  async create(
    tx: OutboxTx,
    input: { type: string; payload: Record<string, unknown> },
  ): Promise<string> {
    assertSafeNotificationPayload(input.payload);
    const id = randomUUID();
    await insertOutboxEventRow(tx, {
      id,
      type: input.type,
      payload: input.payload as Prisma.InputJsonValue,
    });
    return id;
  }

  async enqueue(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.queue.add(
          OUTBOX_DISPATCH_JOB,
          { outboxId: id },
          {
            jobId: outboxJobId(id),
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: true,
          },
        );
      } catch (error) {
        this.logger.warn(
          `Outbox enqueue deferred id=${id} code=${error instanceof Error ? error.name : 'ENQUEUE_FAILED'}`,
        );
      }
    }
  }
}

export async function syncSlaClocks(
  tx: Pick<Prisma.TransactionClient, 'slaClock'>,
  defect: {
    id: string;
    status: 'IN_PROGRESS' | 'COMPLETED';
    claimDeadline: Date | null;
    plannedDeadline: Date | null;
    thirdPartyDeadline: Date | null;
  },
  warningDays: number,
  options: { reopen?: boolean } = {},
): Promise<void> {
  const kinds: SlaClockKind[] = ['GENERAL', 'THIRD_PARTY'];
  for (const kind of kinds) {
    const existing = await tx.slaClock.findUnique({
      where: { defectItemId_kind: { defectItemId: defect.id, kind } },
    });
    const nextDeadline =
      kind === 'GENERAL'
        ? (defect.claimDeadline ?? defect.plannedDeadline)
        : defect.thirdPartyDeadline;
    const previous = existing?.deadline ? calendarDateInTimeZone(existing.deadline) : null;
    const next = nextDeadline ? calendarDateInTimeZone(nextDeadline) : null;
    const bump = options.reopen === true || previous !== next;
    const cycle = nextClockCycle({ previousCycle: existing?.cycle ?? null, bump });
    const state = slaStateOf({
      status: defect.status,
      deadline: nextDeadline,
      warningDays,
    });
    const data = {
      deadline: nextDeadline,
      cycle,
      state,
      satisfiedAt: state === 'COMPLETED' ? (existing?.satisfiedAt ?? new Date()) : null,
      version: (existing?.version ?? 0) + 1,
      updatedAt: new Date(),
    };
    if (existing) {
      await tx.slaClock.update({ where: { id: existing.id }, data });
    } else {
      await tx.slaClock.create({
        data: {
          id: randomUUID(),
          defectItemId: defect.id,
          kind,
          ...data,
          version: 1,
        },
      });
    }
  }
}
