import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  createPropertyObjectRequestSchema,
  linkObjectResponsibleEngineerSchema,
  objectsListQuerySchema,
  type ObjectsDirectoryResponse,
  type ObjectsResponsibleEngineer,
} from '@sgr-registry/contracts';
import {
  BUSINESS_TIME_ZONE,
  OBJECTS_DIRECTORY_DEFAULT_PAGE_SIZE,
  OBJECTS_DIRECTORY_MAX_PAGE_SIZE,
  calendarDateInTimeZone,
  calendarDateToUtcNoon,
  canCreatePropertyObject,
  canManageUsers,
  canViewObjectsDirectory,
  classifyEngineerMatch,
  DuplicateValueError,
  parseManualObjectInput,
  ValidationError,
} from '@sgr-registry/domain';
import {
  applyDirectoryEngineerLink,
  clearDirectoryEngineerLink,
  createPropertyObjectViaDefiner,
  type Prisma,
} from '@sgr-registry/database';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../auth/prisma.tokens';
import { parseCommandBody } from '../common/command-body';
import { actorContext } from '../common/request-context';
import { RegistryAccessScope } from '../registry/registry-access-scope';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DIRECTORY_ENGINEER_SELECT = {
  unassignedAt: true,
  directoryLinkMethod: true,
  assignedAt: true,
  user: { select: { id: true, fullName: true, status: true, role: true } },
} as const;

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
      AND: [
        { active: true },
        ...(scope.objectScoped ? [scope.assignedObjectWhere()] : []),
        ...(engineer
          ? [
              {
                OR: [
                  { sourceResponsibleEngineerName: engineer },
                  {
                    engineers: {
                      some: {
                        directoryLinkMethod: { not: null },
                        user: { fullName: engineer },
                      },
                    },
                  },
                ],
              },
            ]
          : []),
        ...(search.length >= 2
          ? [
              {
                OR: [
                  { name: { contains: search, mode: 'insensitive' as const } },
                  { address: { contains: search, mode: 'insensitive' as const } },
                  {
                    sourceResponsibleEngineerName: {
                      contains: search,
                      mode: 'insensitive' as const,
                    },
                  },
                  {
                    engineers: {
                      some: {
                        directoryLinkMethod: { not: null },
                        user: { fullName: { contains: search, mode: 'insensitive' as const } },
                      },
                    },
                  },
                ],
              },
            ]
          : []),
      ],
    };

    const optionWhere: Prisma.PropertyObjectWhereInput = {
      active: true,
      ...(scope.objectScoped ? scope.assignedObjectWhere() : {}),
    };

    const [totalCount, optionRows, engineerAccounts] = await Promise.all([
      this.prisma.client.propertyObject.count({ where }),
      this.prisma.client.propertyObject.findMany({
        where: optionWhere,
        select: {
          sourceResponsibleEngineerName: true,
          engineers: {
            where: { directoryLinkMethod: { not: null }, unassignedAt: null },
            select: { user: { select: { fullName: true } } },
          },
        },
      }),
      this.prisma.client.user.findMany({
        where: { role: 'RESPONSIBLE_ENGINEER', status: 'ACTIVE' },
        select: { id: true, fullName: true, role: true, status: true },
        orderBy: { fullName: 'asc' },
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
        engineers: {
          where: { directoryLinkMethod: { not: null } },
          select: DIRECTORY_ENGINEER_SELECT,
          orderBy: [{ unassignedAt: { sort: 'asc', nulls: 'first' } }, { assignedAt: 'desc' }],
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const optionNames = new Set<string>();
    for (const row of optionRows) {
      if (row.sourceResponsibleEngineerName) {
        optionNames.add(row.sourceResponsibleEngineerName);
      }
      for (const assignment of row.engineers) {
        optionNames.add(assignment.user.fullName);
      }
    }

    return {
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        address: item.address,
        commissionedAt: item.commissionedAt
          ? calendarDateInTimeZone(item.commissionedAt, BUSINESS_TIME_ZONE)
          : null,
        warrantyEndsAt: item.warrantyEndsAt
          ? calendarDateInTimeZone(item.warrantyEndsAt, BUSINESS_TIME_ZONE)
          : null,
        responsibleEngineer: toResponsibleEngineer(item, engineerAccounts),
      })),
      page,
      pageSize,
      totalCount,
      totalPages,
      responsibleEngineerOptions: [...optionNames].sort((a, b) => a.localeCompare(b, 'ru')),
      canCreate: canCreatePropertyObject(user.role),
      createEngineerOptions: canCreatePropertyObject(user.role)
        ? engineerAccounts.map((row) => ({ id: row.id, fullName: row.fullName }))
        : [],
    };
  }

  async create(
    user: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{
    id: string;
    name: string;
    address: string | null;
    commissionedAt: string | null;
    warrantyEndsAt: string | null;
  }> {
    if (!canCreatePropertyObject(user.role)) {
      throw new ForbiddenException('Недостаточно прав');
    }
    const parsed = parseCommandBody(createPropertyObjectRequestSchema, body);
    const input = parseManualObjectInput(parsed);
    const ctx = actorContext(user, request);
    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        return createPropertyObjectViaDefiner(tx, {
          name: input.name,
          address: input.address,
          commissionedAt: input.commissionedAt ? calendarDateToUtcNoon(input.commissionedAt) : null,
          warrantyEndsAt: input.warrantyEndsAt ? calendarDateToUtcNoon(input.warrantyEndsAt) : null,
          responsibleEngineerId: input.responsibleEngineerId,
          responsibleEngineerName: input.responsibleEngineerName,
          actorUserId: user.id,
          actorName: user.fullName,
          requestId: ctx.requestId,
        });
      });
      return {
        id: created.id,
        name: created.name,
        address: created.address,
        commissionedAt: created.commissionedAt
          ? calendarDateInTimeZone(created.commissionedAt, BUSINESS_TIME_ZONE)
          : null,
        warrantyEndsAt: created.warrantyEndsAt
          ? calendarDateInTimeZone(created.warrantyEndsAt, BUSINESS_TIME_ZONE)
          : null,
      };
    } catch (error) {
      throw mapCreateObjectError(error);
    }
  }

  async linkResponsibleEngineer(
    user: AuthenticatedUser,
    objectId: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{ ok: true }> {
    if (!canManageUsers(user.role)) {
      throw new ForbiddenException('Недостаточно прав');
    }
    if (!UUID_PATTERN.test(objectId)) {
      throw new NotFoundException('Запись не найдена');
    }
    const input = parseCommandBody(linkObjectResponsibleEngineerSchema, body);
    const ctx = actorContext(user, request);
    const actor = {
      actorUserId: user.id,
      actorName: user.fullName,
      requestId: ctx.requestId,
      source: 'WEB' as const,
    };
    try {
      if (input.userId === null) {
        await clearDirectoryEngineerLink(this.prisma.client, {
          ...actor,
          objectId,
          onlyAuto: false,
          matchResult: 'UNMATCHED',
        });
      } else {
        await applyDirectoryEngineerLink(this.prisma.client, {
          ...actor,
          objectId,
          userId: input.userId,
          method: 'ADMIN_CONFIRMED',
          matchResult: 'MATCHED',
        });
      }
    } catch (error) {
      throw mapDirectoryLinkError(error);
    }
    return { ok: true };
  }
}

function toResponsibleEngineer(
  item: {
    sourceResponsibleEngineerName: string | null;
    engineers: Array<{
      unassignedAt: Date | null;
      user: { id: string; fullName: string; status: 'ACTIVE' | 'ARCHIVED'; role: string };
    }>;
  },
  candidates: Array<{ fullName: string; role: string; status: string }>,
): ObjectsResponsibleEngineer | null {
  const active = item.engineers.find((row) => row.unassignedAt === null);
  const stored = active ?? item.engineers[0];
  if (stored) {
    const accessActive =
      stored.unassignedAt === null &&
      stored.user.status === 'ACTIVE' &&
      stored.user.role === 'RESPONSIBLE_ENGINEER';
    return {
      id: stored.user.id,
      fullName: stored.user.fullName,
      status: stored.user.status,
      linked: true,
      accessActive,
    };
  }
  const source = item.sourceResponsibleEngineerName;
  if (!source) {
    return null;
  }
  const classified = classifyEngineerMatch(source, candidates);
  const linkState =
    classified.result === 'AMBIGUOUS'
      ? 'AMBIGUOUS'
      : classified.result === 'INVALID'
        ? 'INVALID'
        : 'UNMATCHED';
  return { fullName: source, linked: false, linkState };
}

function prismaRawMessage(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
  }
  if (error && typeof error === 'object' && 'meta' in error) {
    const meta = (error as { meta?: { message?: unknown; cause?: unknown; code?: unknown } }).meta;
    if (typeof meta?.message === 'string') {
      parts.push(meta.message);
    }
    if (typeof meta?.cause === 'string') {
      parts.push(meta.cause);
    }
    if (typeof meta?.code === 'string') {
      parts.push(meta.code);
    }
  }
  return parts.join('\n');
}

function mapCreateObjectError(error: unknown): never {
  if (error instanceof DuplicateValueError || error instanceof ValidationError) {
    throw error;
  }
  const message = prismaRawMessage(error);
  if (/23505|P2002|уже существует/.test(message)) {
    throw new DuplicateValueError('Объект с таким названием и адресом уже существует');
  }
  if (/42501|Недостаточно прав/.test(message)) {
    throw new ForbiddenException('Недостаточно прав');
  }
  if (/гарантии/.test(message)) {
    throw new ValidationError(
      'warrantyEndsAt',
      'Дата окончания гарантии не может быть раньше даты приёмки',
    );
  }
  if (/инженера/.test(message)) {
    throw new ValidationError(
      'responsibleEngineerId',
      'Назначить можно только активного ответственного инженера',
    );
  }
  if (/22023|обязательн/.test(message)) {
    throw new ValidationError('name', 'Значение обязательно');
  }
  throw error instanceof Error ? error : new Error(String(error));
}

function mapDirectoryLinkError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/P0002|Запись не найдена/.test(message)) {
    throw new NotFoundException('Запись не найдена');
  }
  if (/42501|Недостаточно прав/.test(message)) {
    throw new ForbiddenException('Недостаточно прав');
  }
  if (/Назначить можно только|Некорректный/.test(message)) {
    throw new ForbiddenException('Недостаточно прав');
  }
  throw error instanceof Error ? error : new Error(String(error));
}
