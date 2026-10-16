import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  createPropertyObjectRequestSchema,
  linkObjectResponsibleEngineerSchema,
  objectsListQuerySchema,
  updatePropertyObjectRequestSchema,
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
  canManageReferenceData,
  canManageUsers,
  canViewObjectsDirectory,
  classifyEngineerMatch,
  DuplicateValueError,
  isOversightRole,
  parseManualObjectInput,
  StaleWriteError,
  ValidationError,
} from '@sgr-registry/domain';
import {
  applyDirectoryEngineerLink,
  clearDirectoryEngineerLink,
  createPropertyObjectViaDefiner,
  updatePropertyObjectViaDefiner,
  type Prisma,
} from '@sgr-registry/database';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { PrismaService } from '../auth/prisma.tokens.js';
import { parseCommandBody } from '../common/command-body.js';
import { actorContext } from '../common/request-context.js';
import { resolveRegistryAccessScope } from '../registry/registry-access-scope.js';
import { syncObjectEngineers } from '../reference-data/sync-object-engineers.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DIRECTORY_ENGINEER_SELECT = {
  unassignedAt: true,
  directoryLinkMethod: true,
  assignedAt: true,
  user: {
    select: {
      id: true,
      lastName: true,
      firstName: true,
      middleName: true,
      fullName: true,
      status: true,
      role: true,
    },
  },
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
    const includeInactive = isOversightRole(user.role);
    const canEdit = canManageReferenceData(user.role);
    const statusFilter = includeInactive
      ? (query.status ?? 'ALL')
      : canEdit
        ? (query.status ?? 'ACTIVE')
        : 'ACTIVE';
    const scope = await resolveRegistryAccessScope(this.prisma.client, user);
    const where: Prisma.PropertyObjectWhereInput = {
      AND: [
        ...(statusFilter === 'ACTIVE'
          ? [{ active: true }]
          : statusFilter === 'ARCHIVED'
            ? [{ active: false }]
            : []),
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
      ...(statusFilter === 'ALL' ? {} : { active: statusFilter === 'ACTIVE' }),
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
        select: {
          id: true,
          lastName: true,
          firstName: true,
          middleName: true,
          fullName: true,
          role: true,
          status: true,
        },
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
        active: true,
        version: true,
        sourceResponsibleEngineerName: true,
        engineers: {
          where: { unassignedAt: null },
          select: DIRECTORY_ENGINEER_SELECT,
          orderBy: [{ assignedAt: 'asc' }, { userId: 'asc' }],
        },
      },
      orderBy: [{ nameSortKey: 'asc' }, { id: 'asc' }],
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
        active: item.active,
        version: item.version,
        responsibleEngineer: toResponsibleEngineer(
          {
            ...item,
            engineers: item.engineers.filter((row) => row.directoryLinkMethod !== null),
          },
          engineerAccounts,
        ),
        responsibleEngineers: toResponsibleEngineers(item),
      })),
      page,
      pageSize,
      totalCount,
      totalPages,
      responsibleEngineerOptions: [...optionNames].sort((a, b) => a.localeCompare(b, 'ru')),
      canCreate: canCreatePropertyObject(user.role),
      canEdit,
      createEngineerOptions: canCreatePropertyObject(user.role)
        ? engineerAccounts.map((row) => ({
            id: row.id,
            lastName: row.lastName,
            firstName: row.firstName,
            middleName: row.middleName,
            fullName: row.fullName,
          }))
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
    const engineerIds = parsed.responsibleEngineerIds;
    const hasEngineerIds = (engineerIds?.length ?? 0) > 0;
    const ctx = actorContext(user, request);
    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        const row = await createPropertyObjectViaDefiner(tx, {
          name: input.name,
          address: input.address,
          commissionedAt: input.commissionedAt ? calendarDateToUtcNoon(input.commissionedAt) : null,
          warrantyEndsAt: input.warrantyEndsAt ? calendarDateToUtcNoon(input.warrantyEndsAt) : null,
          responsibleEngineerId: hasEngineerIds ? null : input.responsibleEngineerId,
          responsibleEngineerName: hasEngineerIds ? null : input.responsibleEngineerName,
          actorUserId: user.id,
          actorName: user.fullName,
          requestId: ctx.requestId,
        });
        if (hasEngineerIds && engineerIds) {
          await syncObjectEngineers(tx, {
            objectId: row.id,
            objectActive: true,
            engineerIds,
            ctx,
          });
        }
        return row;
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

  async update(
    user: AuthenticatedUser,
    objectId: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{
    id: string;
    name: string;
    address: string | null;
    commissionedAt: string | null;
    warrantyEndsAt: string | null;
    active: boolean;
    version: number;
  }> {
    if (!canManageReferenceData(user.role)) {
      throw new ForbiddenException('Недостаточно прав');
    }
    if (!UUID_PATTERN.test(objectId)) {
      throw new NotFoundException('Запись не найдена');
    }
    const parsed = parseCommandBody(updatePropertyObjectRequestSchema, body);
    const input = parseManualObjectInput({
      name: parsed.name,
      address: parsed.address,
    });
    const ctx = actorContext(user, request);
    try {
      const updated = await this.prisma.client.$transaction(async (tx) => {
        const row = await updatePropertyObjectViaDefiner(tx, {
          id: objectId,
          expectedVersion: parsed.expectedVersion,
          name: input.name,
          address: input.address,
          active: parsed.active ?? null,
          actorUserId: user.id,
          actorName: user.fullName,
          requestId: ctx.requestId,
        });
        if (parsed.responsibleEngineerIds) {
          await syncObjectEngineers(tx, {
            objectId,
            objectActive: row.active,
            engineerIds: parsed.responsibleEngineerIds,
            ctx,
          });
        }
        return row;
      });
      return {
        id: updated.id,
        name: updated.name,
        address: updated.address,
        commissionedAt: updated.commissionedAt
          ? calendarDateInTimeZone(updated.commissionedAt, BUSINESS_TIME_ZONE)
          : null,
        warrantyEndsAt: updated.warrantyEndsAt
          ? calendarDateInTimeZone(updated.warrantyEndsAt, BUSINESS_TIME_ZONE)
          : null,
        active: updated.active,
        version: updated.version,
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
    if (input.userIds) {
      const engineerIds = input.userIds;
      await this.prisma.client.$transaction(async (tx) => {
        const object = await tx.propertyObject.findUnique({ where: { id: objectId } });
        if (!object) {
          throw new NotFoundException('Запись не найдена');
        }
        await syncObjectEngineers(tx, {
          objectId,
          objectActive: object.active,
          engineerIds,
          ctx,
        });
      });
      return { ok: true };
    }
    if (input.userId === undefined) {
      throw new ValidationError('userIds', 'Укажите ответственных инженеров');
    }
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
      user: {
        id: string;
        lastName: string;
        firstName: string;
        middleName: string | null;
        fullName: string;
        status: 'ACTIVE' | 'ARCHIVED';
        role: string;
      };
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
      lastName: stored.user.lastName,
      firstName: stored.user.firstName,
      middleName: stored.user.middleName,
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

function toResponsibleEngineers(item: {
  engineers: Array<{
    unassignedAt: Date | null;
    user: {
      id: string;
      lastName: string;
      firstName: string;
      middleName: string | null;
      fullName: string;
      status: 'ACTIVE' | 'ARCHIVED';
      role: string;
    };
  }>;
}): ObjectsResponsibleEngineer[] {
  return item.engineers
    .filter((row) => row.unassignedAt === null)
    .map((row) => ({
      id: row.user.id,
      lastName: row.user.lastName,
      firstName: row.user.firstName,
      middleName: row.user.middleName,
      fullName: row.user.fullName,
      status: row.user.status,
      linked: true as const,
      accessActive: row.user.status === 'ACTIVE' && row.user.role === 'RESPONSIBLE_ENGINEER',
    }));
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
  if (
    error instanceof DuplicateValueError ||
    error instanceof ValidationError ||
    error instanceof StaleWriteError ||
    error instanceof NotFoundException
  ) {
    throw error;
  }
  const message = prismaRawMessage(error);
  if (/40001|изменена другим/.test(message)) {
    throw new StaleWriteError();
  }
  if (/P0002|не найдена/.test(message)) {
    throw new NotFoundException('Запись не найдена');
  }
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
