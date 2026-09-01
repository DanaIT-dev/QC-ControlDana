import { Prisma } from '@prisma/client';

type RawWriter = {
  $executeRaw: Prisma.TransactionClient['$executeRaw'];
};

export async function insertAuditLogRow(
  tx: RawWriter,
  data: {
    actorUserId: string | null;
    actorName: string | null;
    action: string;
    entityType: string;
    entityId: string;
    parentEntityType: string | null;
    parentEntityId: string | null;
    oldValue: Prisma.InputJsonValue | null;
    newValue: Prisma.InputJsonValue | null;
    reason: string | null;
    source: 'WEB' | 'SYSTEM';
    occurredAt: Date;
    ipAddress: string | null;
    requestId: string | null;
  },
): Promise<void> {
  const oldJson = data.oldValue === null ? null : JSON.stringify(data.oldValue);
  const newJson = data.newValue === null ? null : JSON.stringify(data.newValue);
  await tx.$executeRaw`
    SELECT public.sgr_insert_audit_log(
      ${data.actorUserId}::uuid,
      ${data.actorName},
      ${data.action},
      ${data.entityType},
      ${data.entityId},
      ${data.parentEntityType},
      ${data.parentEntityId},
      ${oldJson}::jsonb,
      ${newJson}::jsonb,
      ${data.reason},
      CAST(${data.source} AS public."AuditSource"),
      ${data.occurredAt}::timestamptz,
      ${data.ipAddress},
      ${data.requestId}
    )`;
}

export async function insertOutboxEventRow(
  tx: RawWriter,
  data: { id: string; type: string; payload: Prisma.InputJsonValue },
): Promise<void> {
  const payload = JSON.stringify(data.payload);
  await tx.$executeRaw`
    SELECT public.sgr_insert_outbox_event(
      ${data.id}::uuid,
      ${data.type},
      ${payload}::jsonb
    )`;
}

export async function upsertSlaClockRow(
  tx: RawWriter,
  data: {
    id?: string | null;
    defectItemId: string;
    kind: 'GENERAL' | 'THIRD_PARTY';
    deadline: Date | null;
    cycle: number;
    state: string;
    satisfiedAt: Date | null;
    version: number;
  },
): Promise<void> {
  await tx.$executeRaw`
    SELECT public.sgr_upsert_sla_clock(
      ${data.id ?? null}::uuid,
      ${data.defectItemId}::uuid,
      CAST(${data.kind} AS public."SlaClockKind"),
      ${data.deadline}::timestamptz,
      ${data.cycle}::int,
      CAST(${data.state} AS public."SlaClockState"),
      ${data.satisfiedAt}::timestamptz,
      ${data.version}::int
    )`;
}
