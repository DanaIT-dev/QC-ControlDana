import type { Prisma } from '@prisma/client';

export type UpdatedPropertyObjectRow = {
  id: string;
  name: string;
  address: string | null;
  commissionedAt: Date | null;
  warrantyEndsAt: Date | null;
  sortOrder: number;
  sourceSystem: string | null;
  sourceRow: number | null;
  sourceImportKey: string | null;
  sourceResponsibleEngineerName: string | null;
  active: boolean;
  version: number;
};

export async function updatePropertyObjectViaDefiner(
  tx: { $queryRaw: Prisma.TransactionClient['$queryRaw'] },
  input: {
    id: string;
    expectedVersion: number;
    name: string;
    address: string | null;
    active: boolean | null;
    actorUserId: string;
    actorName: string;
    requestId: string | null;
  },
): Promise<UpdatedPropertyObjectRow> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      name: string;
      address: string | null;
      commissioned_at: Date | null;
      warranty_ends_at: Date | null;
      sort_order: number;
      source_system: string | null;
      source_row: number | null;
      source_import_key: string | null;
      source_responsible_engineer_name: string | null;
      active: boolean;
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
      source_system,
      source_row,
      source_import_key,
      source_responsible_engineer_name,
      active,
      version
    FROM public.sgr_update_property_object(
      ${input.id}::uuid,
      ${input.expectedVersion}::integer,
      ${input.name},
      ${input.address},
      ${input.active}::boolean,
      ${input.actorUserId}::uuid,
      ${input.actorName},
      ${input.requestId}
    )
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('Property object was not updated');
  }
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    commissionedAt: row.commissioned_at,
    warrantyEndsAt: row.warranty_ends_at,
    sortOrder: Number(row.sort_order),
    sourceSystem: row.source_system,
    sourceRow: row.source_row === null ? null : Number(row.source_row),
    sourceImportKey: row.source_import_key,
    sourceResponsibleEngineerName: row.source_responsible_engineer_name,
    active: row.active,
    version: Number(row.version),
  };
}
