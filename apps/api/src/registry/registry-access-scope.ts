import type { Prisma } from '@sgr-registry/database';
import type { UserRole } from '@sgr-registry/contracts';
import { isObjectScopedRole, registryAccessMode } from '@sgr-registry/domain';

const ACTIVE_OBJECT_ASSIGNMENT = { unassignedAt: null } as const;

export class RegistryAccessScope {
  readonly userId: string;
  readonly role: UserRole;

  constructor(user: { id: string; role: UserRole }) {
    this.userId = user.id;
    this.role = user.role;
  }

  get objectScoped(): boolean {
    return isObjectScopedRole(this.role);
  }

  assignedObjectWhere(): Prisma.PropertyObjectWhereInput {
    return {
      engineers: {
        some: { userId: this.userId, ...ACTIVE_OBJECT_ASSIGNMENT },
      },
    };
  }

  assignedObjectRelationWhere(): Prisma.PropertyObjectEngineerWhereInput {
    return { userId: this.userId, ...ACTIVE_OBJECT_ASSIGNMENT };
  }

  defectItemWhere(options?: { includeCancelled?: boolean }): Prisma.DefectItemWhereInput {
    const mode = registryAccessMode(this.role);
    if (mode === 'all') {
      return {};
    }
    if (options?.includeCancelled) {
      return mode === 'object_assigned'
        ? { act: { propertyObject: this.assignedObjectWhere() } }
        : {};
    }
    const uncancelled: Prisma.DefectItemWhereInput = {
      act: { status: { not: 'CANCELLED' } },
    };
    if (mode === 'object_assigned') {
      return {
        AND: [uncancelled, { act: { propertyObject: this.assignedObjectWhere() } }],
      };
    }
    return uncancelled;
  }

  actVisibleWhere(actId: string): Prisma.ActWhereInput {
    const assigned =
      registryAccessMode(this.role) === 'object_assigned'
        ? { propertyObject: this.assignedObjectWhere() }
        : {};
    return {
      id: actId,
      ...assigned,
    };
  }

  objectVisibleWhere(objectId: string): Prisma.PropertyObjectWhereInput {
    if (registryAccessMode(this.role) === 'object_assigned') {
      return { id: objectId, ...this.assignedObjectWhere() };
    }
    return { id: objectId };
  }

  defectItemsOnActWhere(actId: string): Prisma.DefectItemWhereInput {
    if (registryAccessMode(this.role) === 'object_assigned') {
      return {
        actId,
        act: { propertyObject: this.assignedObjectWhere() },
      };
    }
    return { actId };
  }
}
