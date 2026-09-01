import type { Prisma } from '@prisma/client';

export type ActiveSuperAdminRow = {
  email: string;
  status: string;
};

type CatalogClient = {
  $queryRaw: Prisma.TransactionClient['$queryRaw'];
};

export async function listActiveSuperAdmins(prisma: CatalogClient): Promise<ActiveSuperAdminRow[]> {
  return prisma.$queryRaw<ActiveSuperAdminRow[]>`
    SELECT email, status FROM public.sgr_active_super_admins()
  `;
}

export async function countActiveSuperAdmins(prisma: CatalogClient): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT count(*)::bigint AS count FROM public.sgr_active_super_admins()
  `;
  return Number(rows[0]?.count ?? 0);
}
