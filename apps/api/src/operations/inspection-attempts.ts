import type { Prisma } from '@sgr-registry/database';

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
  const updated = await tx.defectInspectionAttempt.updateMany({
    where: { defectItemId: input.defectItemId, status: 'PENDING' },
    data: {
      status: input.status,
      reviewedByUserId: input.userId,
      reviewedAt: input.reviewedAt,
      rejectionReason: input.rejectionReason ?? null,
    },
  });
  return updated.count === 1;
}
