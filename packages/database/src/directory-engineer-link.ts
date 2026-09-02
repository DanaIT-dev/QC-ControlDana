import type { Prisma } from '@prisma/client';
import type { DirectoryEngineerLinkMethod, EngineerMatchResult } from '@sgr-registry/domain';

type RawClient = {
  $queryRaw: Prisma.TransactionClient['$queryRaw'];
  $executeRaw: Prisma.TransactionClient['$executeRaw'];
};

export type DirectoryLinkActor = {
  actorUserId: string | null;
  actorName: string | null;
  requestId: string | null;
  source?: 'WEB' | 'SYSTEM';
};

export type DirectoryLinkWriteResult = {
  changed: boolean;
  action: string;
};

function asAuditSource(source: DirectoryLinkActor['source']): 'WEB' | 'SYSTEM' {
  return source === 'SYSTEM' ? 'SYSTEM' : 'WEB';
}

export async function applyDirectoryEngineerLink(
  tx: RawClient,
  input: DirectoryLinkActor & {
    objectId: string;
    userId: string;
    method: DirectoryEngineerLinkMethod;
    matchResult: EngineerMatchResult;
  },
): Promise<DirectoryLinkWriteResult> {
  const rows = await tx.$queryRaw<Array<{ changed: boolean; action: string }>>`
    SELECT changed, action
    FROM public.sgr_apply_directory_engineer_link(
      ${input.objectId}::uuid,
      ${input.userId}::uuid,
      ${input.method},
      ${input.matchResult},
      ${input.actorUserId}::uuid,
      ${input.actorName},
      ${input.requestId},
      CAST(${asAuditSource(input.source)} AS public."AuditSource")
    )
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('Directory engineer link did not return a row');
  }
  return { changed: Boolean(row.changed), action: row.action };
}

export async function clearDirectoryEngineerLink(
  tx: RawClient,
  input: DirectoryLinkActor & {
    objectId: string;
    onlyAuto: boolean;
    matchResult: EngineerMatchResult;
  },
): Promise<DirectoryLinkWriteResult> {
  const rows = await tx.$queryRaw<Array<{ changed: boolean; action: string }>>`
    SELECT changed, action
    FROM public.sgr_clear_directory_engineer_link(
      ${input.objectId}::uuid,
      ${input.onlyAuto},
      ${input.matchResult},
      ${input.actorUserId}::uuid,
      ${input.actorName},
      ${input.requestId},
      CAST(${asAuditSource(input.source)} AS public."AuditSource")
    )
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('Directory engineer unlink did not return a row');
  }
  return { changed: Boolean(row.changed), action: row.action };
}

export async function revokeEngineerObjectAccess(
  tx: RawClient,
  input: DirectoryLinkActor & { userId: string },
): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ revoked: number }>>`
    SELECT public.sgr_revoke_engineer_object_access(
      ${input.userId}::uuid,
      ${input.actorUserId}::uuid,
      ${input.actorName},
      ${input.requestId},
      CAST(${asAuditSource(input.source)} AS public."AuditSource")
    ) AS revoked
  `;
  return Number(rows[0]?.revoked ?? 0);
}
