import type { PrismaClient } from '@sgr-registry/database';

export type ActorNameParts = {
  lastName: string;
  firstName: string;
  middleName: string | null;
};

export async function loadActorNamePartsByUserId(
  prisma: PrismaClient,
  actorUserIds: Array<string | null | undefined>,
): Promise<Map<string, ActorNameParts>> {
  const ids = [...new Set(actorUserIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, lastName: true, firstName: true, middleName: true },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      { lastName: row.lastName, firstName: row.firstName, middleName: row.middleName },
    ]),
  );
}
