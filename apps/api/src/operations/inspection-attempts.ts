import type { Prisma } from '@sgr-registry/database';
import {
  assertInstantNotBefore,
  InvalidTransitionError,
  TEMPORAL_ORDER_MESSAGE,
} from '@sgr-registry/domain';

type AttemptTx = Prisma.TransactionClient;

export async function openInspectionAttempt(
  tx: AttemptTx,
  input: {
    defectItemId: string;
    userId: string;
    submittedAt: Date;
    comment: string;
  },
): Promise<{ id: string; attemptNumber: number }> {
  const pending = await tx.defectInspectionAttempt.findFirst({
    where: { defectItemId: input.defectItemId, status: 'PENDING' },
    select: { id: true, attemptNumber: true },
  });
  if (pending) {
    return pending;
  }
  const defect = await tx.defectItem.findUniqueOrThrow({
    where: { id: input.defectItemId },
    select: { createdAt: true },
  });
  assertInstantNotBefore(input.submittedAt, defect.createdAt);
  const max = await tx.defectInspectionAttempt.aggregate({
    where: { defectItemId: input.defectItemId },
    _max: { attemptNumber: true },
  });
  const created = await tx.defectInspectionAttempt.create({
    data: {
      defectItemId: input.defectItemId,
      attemptNumber: (max._max.attemptNumber ?? 0) + 1,
      status: 'PENDING',
      submittedByUserId: input.userId,
      submittedAt: input.submittedAt,
      contractorComment: input.comment,
    },
    select: { id: true, attemptNumber: true },
  });
  await tx.attachment.updateMany({
    where: {
      defectItemId: input.defectItemId,
      category: 'REPAIR_EVIDENCE',
      status: 'READY',
      inspectionAttemptId: null,
      archivedAt: null,
    },
    data: { inspectionAttemptId: created.id },
  });
  return created;
}

export async function settleInspectionAttempt(
  tx: AttemptTx,
  input: {
    defectItemId: string;
    status: 'ACCEPTED' | 'REJECTED';
    userId: string;
    reviewedAt: Date;
    rejectionReason?: string | null;
  },
): Promise<boolean> {
  const pending = await tx.defectInspectionAttempt.findFirst({
    where: { defectItemId: input.defectItemId, status: 'PENDING' },
    select: { id: true, submittedAt: true },
  });
  if (!pending) {
    return false;
  }
  const defect = await tx.defectItem.findUniqueOrThrow({
    where: { id: input.defectItemId },
    select: { createdAt: true },
  });
  assertInstantNotBefore(input.reviewedAt, pending.submittedAt);
  assertInstantNotBefore(input.reviewedAt, defect.createdAt);
  const updated = await tx.defectInspectionAttempt.updateMany({
    where: {
      id: pending.id,
      status: 'PENDING',
      submittedAt: { lte: input.reviewedAt },
    },
    data: {
      status: input.status,
      reviewedByUserId: input.userId,
      reviewedAt: input.reviewedAt,
      rejectionReason: input.rejectionReason ?? null,
    },
  });
  if (updated.count !== 1) {
    throw new InvalidTransitionError(TEMPORAL_ORDER_MESSAGE);
  }
  return true;
}
