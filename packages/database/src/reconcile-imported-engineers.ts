import type { Prisma } from '@prisma/client';
import { classifyEngineerMatch } from '@sgr-registry/domain';
import { insertAuditLogRow } from './rls-writes';

export async function reconcileImportedEngineerReferences(
  tx: Prisma.TransactionClient,
  input: {
    actorUserId: string | null;
    actorName: string;
    requestId: string | null;
    source: 'WEB' | 'SYSTEM';
    targetUserId?: string;
  },
): Promise<{ resolved: number }> {
  const engineers = await tx.user.findMany({
    where: { role: 'RESPONSIBLE_ENGINEER', status: 'ACTIVE' },
    select: { id: true, fullName: true, role: true, status: true },
  });
  const unresolved = await tx.importedEngineerReference.findMany({
    where: { resolutionStatus: 'UNMATCHED' },
  });
  let resolved = 0;
  for (const reference of unresolved) {
    const classified = classifyEngineerMatch(reference.sourceNameRaw, engineers);
    if (classified.result !== 'MATCHED' || !classified.matches[0]?.id) {
      continue;
    }
    if (input.targetUserId && classified.matches[0].id !== input.targetUserId) {
      continue;
    }
    await resolveImportedEngineerReference(tx, {
      referenceId: reference.id,
      matchedUserId: classified.matches[0].id,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      requestId: input.requestId,
      source: input.source,
      manual: false,
    });
    resolved += 1;
  }
  return { resolved };
}

export async function resolveImportedEngineerReference(
  tx: Prisma.TransactionClient,
  input: {
    referenceId: string;
    matchedUserId: string;
    actorUserId: string | null;
    actorName: string;
    requestId: string | null;
    source: 'WEB' | 'SYSTEM';
    manual: boolean;
  },
): Promise<{ id: string; matchedUserId: string; alreadyResolved: boolean }> {
  const reference = await tx.importedEngineerReference.findUnique({
    where: { id: input.referenceId },
  });
  if (!reference) {
    throw new Error('Запись не найдена');
  }
  if (
    reference.resolutionStatus === 'RESOLVED' &&
    reference.matchedUserId === input.matchedUserId
  ) {
    return {
      id: reference.id,
      matchedUserId: input.matchedUserId,
      alreadyResolved: true,
    };
  }
  if (reference.resolutionStatus === 'RESOLVED') {
    throw new Error('Инженер уже сопоставлен');
  }
  const user = await tx.user.findUnique({
    where: { id: input.matchedUserId },
    select: { id: true, role: true, status: true, fullName: true },
  });
  if (!user || user.role !== 'RESPONSIBLE_ENGINEER' || user.status !== 'ACTIVE') {
    throw new Error('Можно сопоставить только активного ответственного инженера');
  }
  const existingAssignment = await tx.defectItemEngineer.findUnique({
    where: {
      defectItemId_userId: {
        defectItemId: reference.defectItemId,
        userId: user.id,
      },
    },
  });
  if (!existingAssignment) {
    await tx.defectItemEngineer.create({
      data: { defectItemId: reference.defectItemId, userId: user.id },
    });
  }
  const updated = await tx.importedEngineerReference.update({
    where: { id: reference.id },
    data: {
      resolutionStatus: 'RESOLVED',
      matchedUserId: user.id,
      matchedAt: new Date(),
      matchedByUserId: input.actorUserId,
    },
  });
  const defect = await tx.defectItem.findUnique({
    where: { id: reference.defectItemId },
    select: { actId: true },
  });
  await insertAuditLogRow(tx, {
    actorUserId: input.actorUserId,
    actorName: input.actorName,
    action: input.manual ? 'IMPORTED_ENGINEER_MANUALLY_RESOLVED' : 'IMPORTED_ENGINEER_RESOLVED',
    entityType: 'IMPORTED_ENGINEER_REFERENCE',
    entityId: reference.id,
    parentEntityType: 'DEFECT_ITEM',
    parentEntityId: reference.defectItemId,
    oldValue: {
      sourceNameRaw: reference.sourceNameRaw,
      resolutionStatus: reference.resolutionStatus,
    },
    newValue: {
      sourceNameRaw: updated.sourceNameRaw,
      matchedUserId: user.id,
      resolutionStatus: 'RESOLVED',
      actId: defect?.actId ?? null,
      duplicateAssignmentPrevented: Boolean(existingAssignment),
    },
    reason: null,
    source: input.source,
    occurredAt: new Date(),
    ipAddress: null,
    requestId: input.requestId,
  });
  return { id: updated.id, matchedUserId: user.id, alreadyResolved: false };
}
