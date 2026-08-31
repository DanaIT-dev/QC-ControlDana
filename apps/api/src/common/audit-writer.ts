import { Prisma, insertAuditLogRow } from '@sgr-registry/database';
import { assertAuditPayloadSafe } from '@sgr-registry/domain';

export interface AuditActor {
  id: string;
  fullName: string;
}

export interface AuditWriteInput {
  actor: AuditActor | null;
  action: string;
  entityType: string;
  entityId: string;
  parentEntityType?: string | null;
  parentEntityId?: string | null;
  oldValue?: Prisma.InputJsonValue | null;
  newValue?: Prisma.InputJsonValue | null;
  reason?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  source?: 'WEB' | 'SYSTEM';
}

type AuditDb = {
  $executeRaw: Prisma.TransactionClient['$executeRaw'];
};

export async function writeAuditLog(tx: AuditDb, input: AuditWriteInput): Promise<void> {
  assertAuditPayloadSafe(input.oldValue);
  assertAuditPayloadSafe(input.newValue);
  await insertAuditLogRow(tx, {
    actorUserId: input.actor?.id ?? null,
    actorName: input.actor?.fullName ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    parentEntityType: input.parentEntityType ?? null,
    parentEntityId: input.parentEntityId ?? null,
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
    reason: input.reason ?? null,
    source: input.source ?? 'WEB',
    occurredAt: new Date(),
    requestId: input.requestId ?? null,
    ipAddress: input.ipAddress ?? null,
  });
}

export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
