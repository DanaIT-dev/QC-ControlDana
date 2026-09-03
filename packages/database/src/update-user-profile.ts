import type { Prisma } from '@prisma/client';

export type UpdatedUserProfileRow = {
  id: string;
  fullName: string;
  email: string;
  role: string;
  status: string;
  version: number;
  sessionVersion: number;
  emailChanged: boolean;
};

export async function updateUserProfileViaDefiner(
  tx: { $queryRaw: Prisma.TransactionClient['$queryRaw'] },
  input: {
    targetId: string;
    lastName: string;
    firstName: string;
    middleName: string | null;
    email: string;
    expectedVersion: number;
    actorUserId: string;
    actorName: string;
    requestId: string | null;
  },
): Promise<UpdatedUserProfileRow> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      full_name: string;
      email: string;
      role: string;
      status: string;
      version: number;
      session_version: number;
      email_changed: boolean;
    }>
  >`
    SELECT
      id,
      full_name,
      email,
      role,
      status,
      version,
      session_version,
      email_changed
    FROM public.sgr_update_user_profile(
      ${input.targetId}::uuid,
      ${input.lastName},
      ${input.firstName},
      ${input.middleName},
      ${input.email},
      ${input.expectedVersion}::integer,
      ${input.actorUserId}::uuid,
      ${input.actorName},
      ${input.requestId}
    )
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('User profile was not updated');
  }
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    status: row.status,
    version: Number(row.version),
    sessionVersion: Number(row.session_version),
    emailChanged: row.email_changed,
  };
}
