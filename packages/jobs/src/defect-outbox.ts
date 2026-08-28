import type { Prisma } from '@sgr-registry/database';
import {
  buildOccurrenceKey,
  calendarDateInTimeZone,
  notificationTitle,
  shouldBumpGeneralCycle,
  type NotificationType,
} from '@sgr-registry/domain';
import { OutboxWriter, syncSlaClocks } from './outbox.writer';

type OutboxTx = Prisma.TransactionClient;

async function activeRoleIds(
  tx: OutboxTx,
  role: 'ADMIN' | 'SGR_MANAGER' | 'CONTRACTOR_ENGINEER' | 'RESPONSIBLE_ENGINEER',
): Promise<string[]> {
  const rows = await tx.user.findMany({
    where: { role, status: 'ACTIVE' },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

async function assignedIds(tx: OutboxTx, defectItemId: string): Promise<string[]> {
  const rows = await tx.defectItemEngineer.findMany({
    where: { defectItemId },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}

export async function warningDaysOf(tx: OutboxTx): Promise<number> {
  const settings = await tx.systemSettings.findUnique({ where: { id: 'default' } });
  return settings?.deadlineWarningDays ?? 3;
}

export async function writeDomainOutbox(
  writer: OutboxWriter,
  tx: OutboxTx,
  input: {
    type: NotificationType;
    occurrenceParts: Array<string | number | null | undefined>;
    actId: string | null;
    defectItemId: string | null;
    attachmentId?: string | null;
    actorUserId?: string | null;
    automatic?: boolean;
    extraRecipientIds: string[];
    body?: string;
    kind?: 'GENERAL' | 'THIRD_PARTY';
    cycle?: number;
    deadline?: string | null;
    threshold?: number | null;
  },
): Promise<string> {
  return writer.create(tx, {
    type: input.type,
    payload: {
      type: input.type,
      occurrenceBase: buildOccurrenceKey(input.occurrenceParts),
      actId: input.actId,
      defectItemId: input.defectItemId,
      attachmentId: input.attachmentId ?? null,
      actorUserId: input.actorUserId ?? null,
      automatic: input.automatic === true,
      extraRecipientIds: input.extraRecipientIds,
      body: input.body ?? notificationTitle(input.type),
      kind: input.kind ?? null,
      cycle: input.cycle ?? null,
      deadline: input.deadline ?? null,
      threshold: input.threshold ?? null,
    },
  });
}

export async function notifyResponsibleAssigned(
  writer: OutboxWriter,
  tx: OutboxTx,
  input: {
    actId: string;
    defectItemId: string;
    userIds: string[];
    actorUserId: string;
    version: number;
  },
): Promise<string[]> {
  const ids: string[] = [];
  for (const userId of input.userIds) {
    ids.push(
      await writeDomainOutbox(writer, tx, {
        type: 'RESPONSIBLE_ASSIGNED',
        occurrenceParts: ['RESPONSIBLE_ASSIGNED', input.defectItemId, userId, input.version],
        actId: input.actId,
        defectItemId: input.defectItemId,
        actorUserId: input.actorUserId,
        extraRecipientIds: [userId],
      }),
    );
  }
  return ids;
}

export async function revokeRecipientsForUsers(
  tx: OutboxTx,
  defectItemId: string,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) {
    return;
  }
  const result = await tx.notificationRecipient.updateMany({
    where: {
      userId: { in: userIds },
      revokedAt: null,
      event: { defectItemId },
    },
    data: { revokedAt: new Date() },
  });
  if (result.count > 0) {
    await tx.auditLog.create({
      data: {
        action: 'NOTIFICATION_RECIPIENT_REVOKED',
        entityType: 'DEFECT_ITEM',
        entityId: defectItemId,
        newValue: { userIds, count: result.count },
        source: 'SYSTEM',
        occurredAt: new Date(),
      },
    });
  }
}

export async function notifyDeadlineChanges(
  writer: OutboxWriter,
  tx: OutboxTx,
  input: {
    actId: string;
    defectItemId: string;
    actorUserId: string;
    previous: {
      claimDeadline: Date | null;
      plannedDeadline: Date | null;
      thirdPartyDeadline: Date | null;
    };
    next: {
      id: string;
      status: 'IN_PROGRESS' | 'COMPLETED';
      claimDeadline: Date | null;
      plannedDeadline: Date | null;
      thirdPartyDeadline: Date | null;
    };
  },
): Promise<string[]> {
  const warningDays = await warningDaysOf(tx);
  await syncSlaClocks(tx, input.next, warningDays);
  const ids: string[] = [];
  const assigned = await assignedIds(tx, input.defectItemId);
  const managers = await activeRoleIds(tx, 'SGR_MANAGER');
  if (
    shouldBumpGeneralCycle({
      previousClaim: input.previous.claimDeadline,
      previousPlanned: input.previous.plannedDeadline,
      nextClaim: input.next.claimDeadline,
      nextPlanned: input.next.plannedDeadline,
    })
  ) {
    const clock = await tx.slaClock.findUnique({
      where: { defectItemId_kind: { defectItemId: input.defectItemId, kind: 'GENERAL' } },
    });
    ids.push(
      await writeDomainOutbox(writer, tx, {
        type: 'EFFECTIVE_DEADLINE_CHANGED',
        occurrenceParts: [
          'EFFECTIVE_DEADLINE_CHANGED',
          input.defectItemId,
          clock?.cycle ?? 1,
          clock?.deadline ? calendarDateInTimeZone(clock.deadline) : 'none',
        ],
        actId: input.actId,
        defectItemId: input.defectItemId,
        actorUserId: input.actorUserId,
        extraRecipientIds: [...assigned, ...managers],
        kind: 'GENERAL',
        cycle: clock?.cycle,
        deadline: clock?.deadline ? calendarDateInTimeZone(clock.deadline) : null,
      }),
    );
  }
  const previousThird = input.previous.thirdPartyDeadline
    ? calendarDateInTimeZone(input.previous.thirdPartyDeadline)
    : null;
  const nextThird = input.next.thirdPartyDeadline
    ? calendarDateInTimeZone(input.next.thirdPartyDeadline)
    : null;
  if (previousThird !== nextThird) {
    const clock = await tx.slaClock.findUnique({
      where: { defectItemId_kind: { defectItemId: input.defectItemId, kind: 'THIRD_PARTY' } },
    });
    const contractors = await activeRoleIds(tx, 'CONTRACTOR_ENGINEER');
    ids.push(
      await writeDomainOutbox(writer, tx, {
        type: 'THIRD_PARTY_DEADLINE_CHANGED',
        occurrenceParts: [
          'THIRD_PARTY_DEADLINE_CHANGED',
          input.defectItemId,
          clock?.cycle ?? 1,
          nextThird ?? 'none',
        ],
        actId: input.actId,
        defectItemId: input.defectItemId,
        actorUserId: input.actorUserId,
        extraRecipientIds: [...contractors, ...managers],
        kind: 'THIRD_PARTY',
        cycle: clock?.cycle,
        deadline: nextThird,
      }),
    );
  }
  return ids;
}

export async function notifyDefectStatus(
  writer: OutboxWriter,
  tx: OutboxTx,
  input: {
    type: 'DEFECT_COMPLETED' | 'DEFECT_REOPENED';
    actId: string;
    defectItemId: string;
    actorUserId: string;
    defect: {
      id: string;
      status: 'IN_PROGRESS' | 'COMPLETED';
      claimDeadline: Date | null;
      plannedDeadline: Date | null;
      thirdPartyDeadline: Date | null;
    };
    reopen?: boolean;
  },
): Promise<string[]> {
  const warningDays = await warningDaysOf(tx);
  await syncSlaClocks(tx, input.defect, warningDays, { reopen: input.reopen });
  const assigned = await assignedIds(tx, input.defectItemId);
  const managers = await activeRoleIds(tx, 'SGR_MANAGER');
  const clock = await tx.slaClock.findUnique({
    where: { defectItemId_kind: { defectItemId: input.defectItemId, kind: 'GENERAL' } },
  });
  return [
    await writeDomainOutbox(writer, tx, {
      type: input.type,
      occurrenceParts: [input.type, input.defectItemId, clock?.cycle ?? 1],
      actId: input.actId,
      defectItemId: input.defectItemId,
      actorUserId: input.actorUserId,
      extraRecipientIds: [...assigned, ...managers],
      kind: 'GENERAL',
      cycle: clock?.cycle,
    }),
  ];
}

export async function notifyAttachmentScan(
  writer: OutboxWriter,
  tx: OutboxTx,
  input: {
    type: 'ATTACHMENT_READY' | 'ATTACHMENT_REJECTED' | 'ATTACHMENT_SCAN_FAILED';
    attachmentId: string;
    actId: string | null;
    defectItemId: string | null;
    uploadedById: string;
    proposalSlot?: 'A' | 'B' | 'C' | null;
    uploaderRole?: string;
  },
): Promise<string[]> {
  if (!input.actId) {
    return [];
  }
  const extraRecipientIds = [input.uploadedById];
  if (
    input.uploaderRole === 'RESPONSIBLE_ENGINEER' &&
    (input.proposalSlot === 'B' || input.proposalSlot === 'C')
  ) {
    return [];
  }
  if (input.type === 'ATTACHMENT_SCAN_FAILED') {
    extraRecipientIds.push(
      ...(await activeRoleIds(tx, 'SGR_MANAGER')),
      ...(await activeRoleIds(tx, 'ADMIN')),
    );
  }
  return [
    await writeDomainOutbox(writer, tx, {
      type: input.type,
      occurrenceParts: [input.type, input.attachmentId],
      actId: input.actId,
      defectItemId: input.defectItemId,
      attachmentId: input.attachmentId,
      automatic: true,
      extraRecipientIds,
    }),
  ];
}
