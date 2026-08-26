import type { Prisma } from '@sgr-registry/database';
import type { UserRole } from '@sgr-registry/contracts';
import { registryAccessMode } from '@sgr-registry/domain';

export class RegistryAccessScope {
  readonly userId: string;
  readonly role: UserRole;

  constructor(user: { id: string; role: UserRole }) {
    this.userId = user.id;
    this.role = user.role;
  }

  defectItemWhere(): Prisma.DefectItemWhereInput {
    const uncancelled: Prisma.DefectItemWhereInput = {
      act: { status: { not: 'CANCELLED' } },
    };
    if (registryAccessMode(this.role) === 'assigned_only') {
      return {
        AND: [uncancelled, { responsibleEngineers: { some: { userId: this.userId } } }],
      };
    }
    return uncancelled;
  }

  actVisibleWhere(actId: string): Prisma.ActWhereInput {
    const assigned =
      registryAccessMode(this.role) === 'assigned_only'
        ? { defectItems: { some: { responsibleEngineers: { some: { userId: this.userId } } } } }
        : {};
    return {
      id: actId,
      ...assigned,
    };
  }

  defectItemsOnActWhere(actId: string): Prisma.DefectItemWhereInput {
    if (registryAccessMode(this.role) === 'assigned_only') {
      return {
        actId,
        responsibleEngineers: { some: { userId: this.userId } },
      };
    }
    return { actId };
  }
}
