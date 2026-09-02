import type { Prisma } from '@prisma/client';

export type CreatedPropertyObjectRow = {
  id: string;
  name: string;
  address: string | null;
  commissionedAt: Date | null;
  warrantyEndsAt: Date | null;
  sortOrder: number;
  sourceResponsibleEngineerName: string | null;
  version: number;
};

export async function createPropertyObjectViaDefiner(
  tx: { $queryRaw: Prisma.TransactionClient['$queryRaw'] },
  input: {
    name: string;
    address: string | null;
    commissionedAt: Date | null;
    warrantyEndsAt: Date | null;
    responsibleEngineerId: string | null;
    responsibleEngineerName: string | null;
    actorUserId: string;
    actorName: string;
    requestId: string | null;
  },
): Promise<CreatedPropertyObjectRow> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      name: string;
      address: string | null;
      commissioned_at: Date | null;
      warranty_ends_at: Date | null;
      sort_order: number;
      source_responsible_engineer_name: string | null;
      version: number;
    }>
  >`
    SELECT
      id,
      name,
      address,
      commissioned_at,
      warranty_ends_at,
      sort_order,
      source_responsible_engineer_name,
      version
    FROM public.sgr_create_property_object(
      ${input.name},
      ${input.address},
      ${input.commissionedAt}::timestamptz,
      ${input.warrantyEndsAt}::timestamptz,
      ${input.responsibleEngineerId}::uuid,
      ${input.responsibleEngineerName},
      ${input.actorUserId}::uuid,
      ${input.actorName},
      ${input.requestId}
    )
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('Property object was not created');
  }
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    commissionedAt: row.commissioned_at,
    warrantyEndsAt: row.warranty_ends_at,
    sortOrder: Number(row.sort_order),
    sourceResponsibleEngineerName: row.source_responsible_engineer_name,
    version: Number(row.version),
  };
}
