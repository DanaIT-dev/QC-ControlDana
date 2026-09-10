import type { Prisma } from '@prisma/client';

export type PendingUserRow = {
  id: string;
  full_name: string;
  email: string;
  current_role: 'PENDING_ROLE';
  status: 'ACTIVE' | 'ARCHIVED';
  archived_at: Date | null;
  must_change_password: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
};

export async function createPendingUserViaDefiner(
  tx: { $queryRaw: Prisma.TransactionClient['$queryRaw'] },
  input: {
    lastName: string;
    firstName: string;
    middleName: string | null;
    email: string;
    passwordHash: string;
    actorUserId: string;
    actorName: string;
    requestId: string | null;
  },
): Promise<PendingUserRow> {
  const rows = await tx.$queryRaw<PendingUserRow[]>`
    SELECT
      id,
      full_name,
      email,
      "current_role"::text AS current_role,
      status::text AS status,
      archived_at,
      must_change_password,
      version,
      created_at,
      updated_at,
      last_login_at
    FROM public.sgr_create_pending_user(
      ${input.lastName},
      ${input.firstName},
      ${input.middleName},
      ${input.email},
      ${input.passwordHash},
      ${input.actorUserId}::uuid,
      ${input.actorName},
      ${input.requestId}
    )
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('Pending user was not created');
  }
  return row;
}
