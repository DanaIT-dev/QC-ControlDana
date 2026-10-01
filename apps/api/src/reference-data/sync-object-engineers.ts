import { randomUUID } from 'node:crypto';
import type { Prisma } from '@sgr-registry/database';
import { ASSIGNABLE_ENGINEER_ROLE, ValidationError, assertUniqueIds } from '@sgr-registry/domain';
import { toJsonValue, writeAuditLog, type AuditWriteInput } from '../common/audit-writer.js';

type AssignmentAuditContext = Pick<AuditWriteInput, 'actor' | 'requestId' | 'ipAddress'>;

export async function syncObjectEngineers(
  tx: Prisma.TransactionClient,
  input: {
    objectId: string;
    objectActive: boolean;
    engineerIds: string[];
    ctx: AssignmentAuditContext;
  },
): Promise<void> {
  const nextIds = assertUniqueIds(input.engineerIds, 'responsibleEngineerIds');
  const current = await tx.propertyObjectEngineer.findMany({
    where: { propertyObjectId: input.objectId },
  });
  const activeIds = current.filter((row) => row.unassignedAt === null).map((row) => row.userId);
  const activeSet = new Set(activeIds);
  const nextSet = new Set(nextIds);
  const toAdd = nextIds.filter((id) => !activeSet.has(id));
  const toRemove = activeIds.filter((id) => !nextSet.has(id));

  if (!input.objectActive && toAdd.length > 0) {
    throw new ValidationError(
      'responsibleEngineerIds',
      'Архивный объект нельзя назначать новым инженерам',
    );
  }

  if (toAdd.length > 0) {
    const users = await tx.user.findMany({
      where: { id: { in: toAdd } },
      select: { id: true, role: true, status: true },
    });
    if (users.length !== toAdd.length) {
      throw new ValidationError('responsibleEngineerIds', 'Инженер не найден');
    }
    if (users.some((row) => row.status !== 'ACTIVE' || row.role !== ASSIGNABLE_ENGINEER_ROLE)) {
      throw new ValidationError(
        'responsibleEngineerIds',
        'Назначить можно только активного ответственного инженера',
      );
    }
  }

  if (toAdd.length === 0 && toRemove.length === 0) {
    return;
  }

  const now = new Date();
  const assignedByUserId = input.ctx.actor?.id ?? null;
  for (const userId of toAdd) {
    await tx.propertyObjectEngineer.upsert({
      where: {
        propertyObjectId_userId: {
          propertyObjectId: input.objectId,
          userId,
        },
      },
      create: {
        id: randomUUID(),
        propertyObjectId: input.objectId,
        userId,
        assignedAt: now,
        assignedByUserId,
      },
      update: {
        unassignedAt: null,
        assignedAt: now,
        assignedByUserId,
      },
    });
  }
  if (toRemove.length > 0) {
    await tx.propertyObjectEngineer.updateMany({
      where: {
        propertyObjectId: input.objectId,
        userId: { in: toRemove },
        unassignedAt: null,
      },
      data: { unassignedAt: now },
    });
  }

  await writeAuditLog(tx, {
    ...input.ctx,
    action: 'OBJECT_ENGINEERS_REPLACED',
    entityType: 'PROPERTY_OBJECT',
    entityId: input.objectId,
    oldValue: toJsonValue({ responsibleEngineerIds: activeIds }),
    newValue: toJsonValue({ responsibleEngineerIds: nextIds }),
  });
}
