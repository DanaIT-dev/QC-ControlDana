import type { Prisma, PrismaClient } from '@sgr-registry/database';
import type { UserRole } from '@sgr-registry/contracts';
import { isObjectScopedRole, registryAccessMode } from '@sgr-registry/domain';

const ACTIVE_OBJECT_ASSIGNMENT = { unassignedAt: null } as const;

type MembershipReader = {
  userOrganizationMembership: {
    findMany: (args: {
      where: { userId: string; revokedAt: null };
      select: { organizationId: true };
    }) => Promise<Array<{ organizationId: string }>>;
  };
};

export class RegistryAccessScope {
  readonly userId: string;
  readonly role: UserRole;
  readonly organizationIds: readonly string[];

  constructor(user: { id: string; role: UserRole }, organizationIds: readonly string[] = []) {
    this.userId = user.id;
    this.role = user.role;
    this.organizationIds = organizationIds;
  }

  get objectScoped(): boolean {
    return isObjectScopedRole(this.role);
  }

  get organizationScoped(): boolean {
    return registryAccessMode(this.role) === 'organization_liable';
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

  liableDefectWhere(): Prisma.DefectItemWhereInput {
    return {
      liableOrganizations: {
        some: { organizationId: { in: [...this.organizationIds] } },
      },
    };
  }

  defectItemWhere(options?: { includeCancelled?: boolean }): Prisma.DefectItemWhereInput {
    const mode = registryAccessMode(this.role);
    if (mode === 'all') {
      return {};
    }
    if (mode === 'organization_liable') {
      const liable = this.liableDefectWhere();
      if (options?.includeCancelled) {
        return liable;
      }
      return { AND: [{ act: { status: { not: 'CANCELLED' } } }, liable] };
    }
    if (options?.includeCancelled) {
      return mode === 'object_assigned'
        ? {
            OR: [
              { act: { propertyObject: this.assignedObjectWhere() } },
              { act: { status: 'NEW', createdById: this.userId } },
            ],
          }
        : {};
    }
    const uncancelled: Prisma.DefectItemWhereInput = {
      act: { status: { not: 'CANCELLED' } },
    };
    if (mode === 'object_assigned') {
      return {
        AND: [
          uncancelled,
          {
            OR: [
              { act: { propertyObject: this.assignedObjectWhere() } },
              { act: { status: 'NEW', createdById: this.userId } },
            ],
          },
        ],
      };
    }
    return uncancelled;
  }

  actVisibleWhere(actId: string): Prisma.ActWhereInput {
    const mode = registryAccessMode(this.role);
    if (mode === 'object_assigned') {
      return {
        id: actId,
        OR: [
          { propertyObject: this.assignedObjectWhere() },
          { status: 'NEW', createdById: this.userId },
        ],
      };
    }
    if (mode === 'organization_liable') {
      return {
        id: actId,
        status: { not: 'CANCELLED' },
        defectItems: { some: this.liableDefectWhere() },
      };
    }
    return { id: actId };
  }

  objectVisibleWhere(objectId: string): Prisma.PropertyObjectWhereInput {
    const mode = registryAccessMode(this.role);
    if (mode === 'object_assigned') {
      return { id: objectId, ...this.assignedObjectWhere() };
    }
    if (mode === 'organization_liable') {
      return {
        id: objectId,
        acts: {
          some: {
            status: { not: 'CANCELLED' },
            defectItems: { some: this.liableDefectWhere() },
          },
        },
      };
    }
    return { id: objectId };
  }

  defectItemsOnActWhere(actId: string): Prisma.DefectItemWhereInput {
    const mode = registryAccessMode(this.role);
    if (mode === 'object_assigned') {
      return {
        actId,
        OR: [
          { act: { propertyObject: this.assignedObjectWhere() } },
          { act: { status: 'NEW', createdById: this.userId } },
        ],
      };
    }
    if (mode === 'organization_liable') {
      return {
        actId,
        act: { status: { not: 'CANCELLED' } },
        ...this.liableDefectWhere(),
      };
    }
    return { actId };
  }

  emptyDraftWhere(): Prisma.ActWhereInput {
    const draft: Prisma.ActWhereInput = { status: 'NEW', defectItems: { none: {} } };
    const mode = registryAccessMode(this.role);
    if (mode === 'organization_liable') {
      return { id: { in: [] } };
    }
    if (mode === 'object_assigned') {
      return {
        AND: [
          draft,
          {
            OR: [{ propertyObject: this.assignedObjectWhere() }, { createdById: this.userId }],
          },
        ],
      };
    }
    return draft;
  }

  visibleActRelationWhere(): Prisma.ActWhereInput {
    if (this.objectScoped) {
      return {
        AND: [
          { status: { not: 'CANCELLED' } },
          {
            OR: [
              { propertyObject: this.assignedObjectWhere() },
              { status: 'NEW', createdById: this.userId },
            ],
          },
        ],
      };
    }
    if (this.organizationScoped) {
      return {
        status: { not: 'CANCELLED' },
        defectItems: { some: this.liableDefectWhere() },
      };
    }
    return { status: { not: 'CANCELLED' } };
  }
}

export async function resolveRegistryAccessScope(
  db: MembershipReader,
  user: { id: string; role: UserRole },
): Promise<RegistryAccessScope> {
  if (user.role !== 'CONTRACTOR_ENGINEER') {
    return new RegistryAccessScope(user);
  }
  const rows = await db.userOrganizationMembership.findMany({
    where: { userId: user.id, revokedAt: null },
    select: { organizationId: true },
  });
  return new RegistryAccessScope(
    user,
    rows.map((row) => row.organizationId),
  );
}

export type RegistryPrisma = PrismaClient | Prisma.TransactionClient;
