import type { Prisma, PrismaClient } from '@prisma/client';
import { classifyEngineerMatch, type EngineerMatchCandidate } from '@sgr-registry/domain';
import {
  applyDirectoryEngineerLink,
  clearDirectoryEngineerLink,
  type DirectoryLinkActor,
} from './directory-engineer-link';

type ReconcileClient = Prisma.TransactionClient | PrismaClient;
type ReconcileCandidate = EngineerMatchCandidate & { id: string };

export interface ReconcileDirectoryEngineerLinksResult {
  linked: number;
  unchanged: number;
  unlinked: number;
  changed: number;
}

export async function reconcileDirectoryEngineerLinks(
  tx: ReconcileClient,
  actor: DirectoryLinkActor,
  options?: { extraCandidates?: ReconcileCandidate[] },
): Promise<ReconcileDirectoryEngineerLinksResult> {
  const [objects, storedCandidates] = await Promise.all([
    tx.propertyObject.findMany({
      where: { sourceResponsibleEngineerName: { not: null } },
      select: {
        id: true,
        sourceResponsibleEngineerName: true,
        engineers: {
          where: { directoryLinkMethod: { not: null }, unassignedAt: null },
          select: { userId: true, directoryLinkMethod: true },
        },
      },
    }),
    tx.user.findMany({
      where: { role: 'RESPONSIBLE_ENGINEER', status: 'ACTIVE' },
      select: { id: true, fullName: true, role: true, status: true },
    }),
  ]);
  const candidatesById = new Map<string, ReconcileCandidate>();
  for (const candidate of storedCandidates) {
    candidatesById.set(candidate.id, candidate);
  }
  for (const candidate of options?.extraCandidates ?? []) {
    candidatesById.set(candidate.id, candidate);
  }
  const candidates = [...candidatesById.values()];

  const grouped = new Map<string, typeof objects>();
  for (const object of objects) {
    const name = object.sourceResponsibleEngineerName;
    if (!name) {
      continue;
    }
    const bucket = grouped.get(name) ?? [];
    bucket.push(object);
    grouped.set(name, bucket);
  }

  let linked = 0;
  let unchanged = 0;
  let unlinked = 0;

  for (const [sourceName, group] of grouped) {
    const classified = classifyEngineerMatch(sourceName, candidates);
    const matchedId = classified.result === 'MATCHED' ? classified.matches[0]?.id : undefined;

    for (const object of group) {
      const current = object.engineers[0];
      if (classified.result === 'MATCHED' && matchedId) {
        if (current?.directoryLinkMethod === 'ADMIN_CONFIRMED') {
          unchanged += 1;
          continue;
        }
        const result = await applyDirectoryEngineerLink(tx, {
          ...actor,
          objectId: object.id,
          userId: matchedId,
          method: 'AUTO_EXACT',
          matchResult: 'MATCHED',
        });
        if (result.changed) {
          linked += 1;
        } else {
          unchanged += 1;
        }
        continue;
      }

      if (current?.directoryLinkMethod === 'ADMIN_CONFIRMED') {
        unchanged += 1;
        continue;
      }

      const matchResult =
        classified.result === 'AMBIGUOUS' || classified.result === 'INVALID'
          ? classified.result
          : 'UNMATCHED';
      const result = await clearDirectoryEngineerLink(tx, {
        ...actor,
        objectId: object.id,
        onlyAuto: true,
        matchResult,
      });
      if (result.changed) {
        unlinked += 1;
      } else {
        unchanged += 1;
      }
    }
  }

  return {
    linked,
    unchanged,
    unlinked,
    changed: linked + unlinked,
  };
}
