import type { Prisma } from '@prisma/client';

export type StartedActRow = {
  id: string;
  status: 'NEW' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  startedAt: Date | null;
  startedById: string | null;
  startedByName: string | null;
  version: number;
  alreadyStarted: boolean;
};

export async function startActViaDefiner(
  tx: { $queryRaw: Prisma.TransactionClient['$queryRaw'] },
  input: { actId: string; requestId: string | null },
): Promise<StartedActRow> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      status: string;
      started_at: Date | null;
      started_by_id: string | null;
      started_by_name: string | null;
      version: number;
      already_started: boolean;
    }>
  >`
    SELECT
      id,
      status,
      started_at,
      started_by_id,
      started_by_name,
      version,
      already_started
    FROM public.sgr_start_act(${input.actId}::uuid, ${input.requestId})
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('Act start did not return a row');
  }
  return {
    id: row.id,
    status: row.status as StartedActRow['status'],
    startedAt: asDate(row.started_at),
    startedById: row.started_by_id,
    startedByName: row.started_by_name,
    version: row.version,
    alreadyStarted: Boolean(row.already_started),
  };
}

function asDate(value: Date | string | null): Date | null {
  if (value == null) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}
