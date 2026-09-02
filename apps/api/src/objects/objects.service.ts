import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  objectsListQuerySchema,
  type ObjectsDirectoryResponse,
  type ObjectsResponsibleAccountStatus,
} from '@sgr-registry/contracts';
import {
  BUSINESS_TIME_ZONE,
  OBJECTS_DIRECTORY_DEFAULT_PAGE_SIZE,
  OBJECTS_DIRECTORY_MAX_PAGE_SIZE,
  calendarDateInTimeZone,
  canViewObjectsDirectory,
  classifyResponsibleEngineerName,
} from '@sgr-registry/domain';
import type { Prisma } from '@sgr-registry/database';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../auth/prisma.tokens';
import { parseCommandBody } from '../common/command-body';
import { RegistryAccessScope } from '../registry/registry-access-scope';

@Injectable()
export class ObjectsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(
    user: AuthenticatedUser,
    rawQuery: Record<string, unknown>,
  ): Promise<ObjectsDirectoryResponse> {
    if (!canViewObjectsDirectory(user.role)) {
      throw new ForbiddenException('Недостаточно прав');
    }
    const query = parseCommandBody(objectsListQuerySchema, rawQuery);
    const pageSize = Math.min(
      query.pageSize ?? OBJECTS_DIRECTORY_DEFAULT_PAGE_SIZE,
      OBJECTS_DIRECTORY_MAX_PAGE_SIZE,
    );
    const requestedPage = query.page ?? 1;
    const search = query.search?.trim() ?? '';
    const engineer = query.responsibleEngineer?.trim() ?? '';
    const scope = new RegistryAccessScope(user);
    const where: Prisma.PropertyObjectWhereInput = {
      active: true,
      ...(scope.objectScoped ? scope.assignedObjectWhere() : {}),
      ...(engineer ? { sourceResponsibleEngineerName: engineer } : {}),
      ...(search.length >= 2
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { address: { contains: search, mode: 'insensitive' } },
              { sourceResponsibleEngineerName: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [totalCount, engineerRows, engineerAccounts] = await Promise.all([
      this.prisma.client.propertyObject.count({ where }),
      this.prisma.client.propertyObject.findMany({
        where: {
          active: true,
          ...(scope.objectScoped ? scope.assignedObjectWhere() : {}),
          sourceResponsibleEngineerName: { not: null },
        },
        select: { sourceResponsibleEngineerName: true },
        distinct: ['sourceResponsibleEngineerName'],
        orderBy: { sourceResponsibleEngineerName: 'asc' },
      }),
      this.prisma.client.user.findMany({
        where: { role: 'RESPONSIBLE_ENGINEER', status: 'ACTIVE' },
        select: { fullName: true, role: true, status: true },
      }),
    ]);
    const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize);
    const page = totalCount === 0 ? 1 : Math.min(requestedPage, Math.max(totalPages, 1));
    const items = await this.prisma.client.propertyObject.findMany({
      where,
      select: {
        id: true,
        name: true,
        address: true,
        commissionedAt: true,
        warrantyEndsAt: true,
        sourceResponsibleEngineerName: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return {
      items: items.map((item) => {
        const status = classifyResponsibleEngineerName(
          item.sourceResponsibleEngineerName,
          engineerAccounts,
        );
        const accountStatus: ObjectsResponsibleAccountStatus = status;
        return {
          id: item.id,
          name: item.name,
          address: item.address,
          commissionedAt: item.commissionedAt
            ? calendarDateInTimeZone(item.commissionedAt, BUSINESS_TIME_ZONE)
            : null,
          warrantyEndsAt: item.warrantyEndsAt
            ? calendarDateInTimeZone(item.warrantyEndsAt, BUSINESS_TIME_ZONE)
            : null,
          sourceResponsibleEngineerName: item.sourceResponsibleEngineerName,
          responsibleEngineerAccountStatus: accountStatus,
        };
      }),
      page,
      pageSize,
      totalCount,
      totalPages,
      responsibleEngineerOptions: engineerRows
        .map((row) => row.sourceResponsibleEngineerName)
        .filter((name): name is string => Boolean(name)),
    };
  }
}
