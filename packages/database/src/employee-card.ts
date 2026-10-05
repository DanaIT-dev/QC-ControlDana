import type { Prisma } from '@prisma/client';

export type CompletedOwnProfileRow = {
  id: string;
  fullName: string;
  version: number;
};

export async function completeOwnProfileViaDefiner(
  tx: { $queryRaw: Prisma.TransactionClient['$queryRaw'] },
  input: {
    lastName: string;
    firstName: string;
    middleName: string | null;
    fullName: string;
    phone: string;
    birthDate: string;
  },
): Promise<CompletedOwnProfileRow> {
  const rows = await tx.$queryRaw<Array<{ id: string; full_name: string; version: number }>>`
    SELECT id, full_name, version
    FROM public.sgr_complete_own_profile(
      ${input.lastName},
      ${input.firstName},
      ${input.middleName},
      ${input.fullName},
      ${input.phone},
      ${input.birthDate}::date
    )
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('Employee card was not saved');
  }
  return {
    id: row.id,
    fullName: row.full_name,
    version: Number(row.version),
  };
}

export async function updateUserEmploymentViaDefiner(
  tx: { $queryRaw: Prisma.TransactionClient['$queryRaw'] },
  input: {
    targetId: string;
    hiredOn: string | null;
    contractEndsOn: string | null;
    expectedVersion: number;
  },
): Promise<{ id: string; version: number }> {
  const rows = await tx.$queryRaw<Array<{ id: string; version: number }>>`
    SELECT id, version
    FROM public.sgr_update_user_employment(
      ${input.targetId}::uuid,
      ${input.hiredOn}::date,
      ${input.contractEndsOn}::date,
      ${input.expectedVersion}::integer
    )
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('Employment was not updated');
  }
  return { id: row.id, version: Number(row.version) };
}
