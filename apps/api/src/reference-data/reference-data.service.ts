import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  codedReferenceWriteSchema,
  organizationWriteSchema,
  propertyObjectWriteSchema,
  referenceListQuerySchema,
  versionedReasonSchema,
} from '@sgr-registry/contracts';
import {
  BUSINESS_TIME_ZONE,
  calendarDateToUtcNoon,
  DuplicateValueError,
  StaleWriteError,
  UnpConflictError,
  assertCaseInsensitiveUnique,
  calendarDateInTimeZone,
  isValidEmail,
  normalizeContact,
  normalizeOrganizationUnp,
  normalizeReferenceCode,
  normalizeReferenceName,
  normalizeRequiredText,
  parseOptionalCalendarDate,
  ValidationError,
} from '@sgr-registry/domain';
import type { Prisma } from '@sgr-registry/database';
import { createPropertyObjectViaDefiner } from '@sgr-registry/database';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../auth/prisma.tokens';
import { toJsonValue, writeAuditLog } from '../common/audit-writer';
import { isPrismaUniqueConflict, parseCommandBody } from '../common/command-body';
import { actorContext } from '../common/request-context';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyWhereAfter,
} from '../common/history-cursor';
import { syncObjectEngineers } from './sync-object-engineers';

export type ReferenceKind = 'property-objects' | 'organizations' | 'work-types' | 'defect-types';

@Injectable()
export class ReferenceDataService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  list(kind: ReferenceKind, rawQuery: Record<string, unknown>) {
    const query = parseCommandBody(referenceListQuerySchema, rawQuery);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const status = query.status ?? 'ALL';
    const search = query.search?.trim() ?? '';
    if (kind === 'property-objects') {
      return this.listPropertyObjects({ page, pageSize, status, search });
    }
    if (kind === 'organizations') {
      return this.listOrganizations({ page, pageSize, status, search });
    }
    if (kind === 'work-types') {
      return this.listCoded('workType', { page, pageSize, status, search });
    }
    return this.listCoded('defectType', { page, pageSize, status, search });
  }

  async create(
    kind: ReferenceKind,
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    if (kind === 'property-objects') {
      return this.createPropertyObject(actor, body, request);
    }
    if (kind === 'organizations') {
      return this.createOrganization(actor, body, request);
    }
    return this.createCoded(
      kind === 'work-types' ? 'workType' : 'defectType',
      actor,
      body,
      request,
    );
  }

  async update(
    kind: ReferenceKind,
    id: string,
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    if (kind === 'property-objects') {
      return this.updatePropertyObject(id, actor, body, request);
    }
    if (kind === 'organizations') {
      return this.updateOrganization(id, actor, body, request);
    }
    return this.updateCoded(
      kind === 'work-types' ? 'workType' : 'defectType',
      id,
      actor,
      body,
      request,
    );
  }

  async archive(
    kind: ReferenceKind,
    id: string,
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    return this.setArchived(kind, id, actor, body, request, true);
  }

  async restore(
    kind: ReferenceKind,
    id: string,
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    return this.setArchived(kind, id, actor, body, request, false);
  }

  async history(kind: ReferenceKind, id: string, rawQuery: Record<string, unknown>) {
    const entityType = entityTypeOf(kind);
    const exists = await this.exists(kind, id);
    if (!exists) {
      throw new NotFoundException('Запись не найдена');
    }
    const query = parseCommandBody(
      (await import('@sgr-registry/contracts')).historyQuerySchema,
      rawQuery,
    );
    const limit = query.limit ?? 50;
    const cursor = query.cursor ? decodeHistoryCursor(query.cursor) : null;
    const rows = await this.prisma.client.auditLog.findMany({
      where: {
        entityType,
        entityId: id,
        ...(cursor ? historyWhereAfter(cursor) : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        oldValue: row.oldValue,
        newValue: row.newValue,
        reason: row.reason,
        actorName: row.actorName,
        occurredAt: row.occurredAt.toISOString(),
      })),
      nextCursor: hasMore ? encodeHistoryCursor(page[page.length - 1]!) : null,
    };
  }

  private async listPropertyObjects(input: ListInput) {
    const where: Prisma.PropertyObjectWhereInput = {
      ...activeWhere(input.status),
      ...(input.search.length >= 2
        ? {
            OR: [
              { name: { contains: input.search, mode: 'insensitive' } },
              { address: { contains: input.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const totalCount = await this.prisma.client.propertyObject.count({ where });
    const items = await this.prisma.client.propertyObject.findMany({
      where,
      include: {
        engineers: {
          where: { unassignedAt: null },
          include: { user: { select: { id: true, fullName: true, email: true, status: true } } },
        },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    });
    return {
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        address: item.address ?? '',
        commissionedAt: item.commissionedAt
          ? calendarDateInTimeZone(item.commissionedAt, BUSINESS_TIME_ZONE)
          : null,
        warrantyEndsAt: item.warrantyEndsAt
          ? calendarDateInTimeZone(item.warrantyEndsAt, BUSINESS_TIME_ZONE)
          : null,
        active: item.active,
        version: item.version,
        archivedAt: item.archivedAt?.toISOString() ?? null,
        responsibleEngineers: item.engineers.map((row) => ({
          id: row.user.id,
          fullName: row.user.fullName,
          email: row.user.email,
        })),
      })),
      ...pageMeta(input, totalCount),
    };
  }

  private async listOrganizations(input: ListInput) {
    const where: Prisma.OrganizationWhereInput = {
      ...activeWhere(input.status),
      ...(input.search.length >= 2
        ? {
            OR: [
              { officialName: { contains: input.search, mode: 'insensitive' } },
              { unp: { contains: input.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const totalCount = await this.prisma.client.organization.count({ where });
    const items = await this.prisma.client.organization.findMany({
      where,
      include: { roles: true },
      orderBy: [{ officialName: 'asc' }, { id: 'asc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    });
    return {
      items: items.map((item) => ({
        id: item.id,
        officialName: item.officialName,
        unp: item.unp,
        postalAddress: item.postalAddress,
        email: item.email,
        phone: item.phone,
        contactPerson: item.contactPerson,
        roles: item.roles.map((role) => role.role),
        active: item.active,
        version: item.version,
        archivedAt: item.archivedAt?.toISOString() ?? null,
      })),
      ...pageMeta(input, totalCount),
    };
  }

  private async listCoded(model: 'workType' | 'defectType', input: ListInput) {
    const client = codedDelegate(this.prisma.client, model);
    const where = {
      ...activeWhere(input.status),
      ...(input.search.length >= 2
        ? {
            OR: [
              { name: { contains: input.search, mode: 'insensitive' } },
              { code: { contains: input.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const totalCount = await client.count({ where });
    const items = await client.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    });
    return {
      items: items.map((item) => ({
        id: item.id,
        code: item.code,
        name: item.name,
        sortOrder: item.sortOrder,
        active: item.active,
        version: item.version,
        archivedAt: item.archivedAt?.toISOString() ?? null,
      })),
      ...pageMeta(input, totalCount),
    };
  }

  private async createPropertyObject(
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(propertyObjectWriteSchema, body);
    const name = normalizeReferenceName(input.name);
    const address = normalizeRequiredText(input.address, 'address', 300);
    const ctx = actorContext(actor, request);
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const created = await createPropertyObjectViaDefiner(tx, {
          name,
          address,
          commissionedAt: optionalDate(input.commissionedAt, 'commissionedAt'),
          warrantyEndsAt: optionalDate(input.warrantyEndsAt, 'warrantyEndsAt'),
          responsibleEngineerId: null,
          responsibleEngineerName: null,
          actorUserId: actor.id,
          actorName: actor.fullName,
          requestId: ctx.requestId,
        });
        if (input.responsibleEngineerIds) {
          await syncObjectEngineers(tx, {
            objectId: created.id,
            objectActive: true,
            engineerIds: input.responsibleEngineerIds,
            ctx,
          });
        }
        return tx.propertyObject.findUniqueOrThrow({ where: { id: created.id } });
      });
    } catch (error) {
      if (isPrismaUniqueConflict(error)) {
        throw new DuplicateValueError();
      }
      throw error;
    }
  }

  private async updatePropertyObject(
    id: string,
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(propertyObjectWriteSchema, body);
    if (!input.expectedVersion) {
      throw new ValidationError('expectedVersion', 'Укажите expectedVersion');
    }
    const name = normalizeReferenceName(input.name);
    const address = normalizeRequiredText(input.address, 'address', 300);
    const others = await this.prisma.client.propertyObject.findMany({
      where: { id: { not: id } },
      select: { name: true },
    });
    assertCaseInsensitiveUnique(
      name,
      others.map((item) => item.name),
    );
    return this.prisma.client.$transaction(async (tx) => {
      const current = await tx.propertyObject.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      if (current.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const ctx = actorContext(actor, request);
      const updated = await tx.propertyObject.updateMany({
        where: { id, version: input.expectedVersion },
        data: {
          name,
          address,
          commissionedAt: optionalDate(input.commissionedAt, 'commissionedAt'),
          warrantyEndsAt: optionalDate(input.warrantyEndsAt, 'warrantyEndsAt'),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      await writeAuditLog(tx, {
        ...ctx,
        action: 'REFERENCE_UPDATED',
        entityType: 'PROPERTY_OBJECT',
        entityId: id,
        oldValue: toJsonValue({ name: current.name, address: current.address }),
        newValue: toJsonValue({ name, address }),
      });
      if (input.responsibleEngineerIds) {
        await syncObjectEngineers(tx, {
          objectId: id,
          objectActive: current.active,
          engineerIds: input.responsibleEngineerIds,
          ctx,
        });
      }
      return tx.propertyObject.findUniqueOrThrow({ where: { id } });
    });
  }

  private async createOrganization(
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(organizationWriteSchema, body);
    const officialName = normalizeReferenceName(input.officialName, 'officialName');
    const unp = normalizeOrganizationUnp(input.unp);
    const email = normalizeContact(input.email, 'email');
    if (!isValidEmail(email)) {
      throw new ValidationError('email', 'Некорректный адрес электронной почты');
    }
    const ctx = actorContext(actor, request);
    const existing = await this.prisma.client.organization.findMany({
      select: { officialName: true, unp: true },
    });
    assertCaseInsensitiveUnique(
      officialName,
      existing.map((item) => item.officialName),
    );
    if (unp && existing.some((item) => item.unp === unp)) {
      throw new UnpConflictError();
    }
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.organization.create({
          data: {
            officialName,
            unp,
            postalAddress: normalizeRequiredText(input.postalAddress, 'postalAddress', 300),
            email,
            phone: normalizeContact(input.phone, 'phone'),
            contactPerson: normalizeContact(input.contactPerson, 'contactPerson'),
            roles: input.roles ? { create: input.roles.map((role) => ({ role })) } : undefined,
          },
          include: { roles: true },
        });
        await writeAuditLog(tx, {
          ...ctx,
          action: 'REFERENCE_CREATED',
          entityType: 'ORGANIZATION',
          entityId: created.id,
          newValue: toJsonValue({ officialName, unp }),
        });
        return created;
      });
    } catch (error) {
      if (isPrismaUniqueConflict(error)) {
        throw new DuplicateValueError();
      }
      throw error;
    }
  }

  private async updateOrganization(
    id: string,
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(organizationWriteSchema, body);
    if (!input.expectedVersion) {
      throw new ValidationError('expectedVersion', 'Укажите expectedVersion');
    }
    const officialName = normalizeReferenceName(input.officialName, 'officialName');
    const ctx = actorContext(actor, request);
    return this.prisma.client.$transaction(async (tx) => {
      const current = await tx.organization.findUnique({
        where: { id },
        include: { roles: true },
      });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      if (current.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const updated = await tx.organization.updateMany({
        where: { id, version: input.expectedVersion },
        data: {
          officialName,
          unp: normalizeOrganizationUnp(input.unp),
          postalAddress: normalizeRequiredText(input.postalAddress, 'postalAddress', 300),
          email: normalizeContact(input.email, 'email'),
          phone: normalizeContact(input.phone, 'phone'),
          contactPerson: normalizeContact(input.contactPerson, 'contactPerson'),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      if (input.roles) {
        await tx.organizationRoleAssignment.deleteMany({ where: { organizationId: id } });
        if (input.roles.length > 0) {
          await tx.organizationRoleAssignment.createMany({
            data: input.roles.map((role) => ({ organizationId: id, role })),
          });
        }
      }
      await writeAuditLog(tx, {
        ...ctx,
        action: 'REFERENCE_UPDATED',
        entityType: 'ORGANIZATION',
        entityId: id,
        oldValue: toJsonValue({ officialName: current.officialName }),
        newValue: toJsonValue({ officialName }),
      });
      return tx.organization.findUniqueOrThrow({ where: { id }, include: { roles: true } });
    });
  }

  private async createCoded(
    model: 'workType' | 'defectType',
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(codedReferenceWriteSchema, body);
    const code = normalizeReferenceCode(input.code);
    const name = normalizeReferenceName(input.name);
    const ctx = actorContext(actor, request);
    const client = codedDelegate(this.prisma.client, model);
    const existing = await client.findMany({ select: { code: true, name: true } });
    assertCaseInsensitiveUnique(
      code,
      existing.map((item) => item.code),
      'Код уже используется',
    );
    assertCaseInsensitiveUnique(
      name,
      existing.map((item) => item.name),
    );
    const maxSort = await client.aggregate({ _max: { sortOrder: true } });
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const created = await codedDelegate(tx, model).create({
          data: {
            code,
            name,
            sortOrder: input.sortOrder ?? (maxSort._max.sortOrder ?? 0) + 1,
          },
        });
        await writeAuditLog(tx, {
          ...ctx,
          action: 'REFERENCE_CREATED',
          entityType: model === 'workType' ? 'WORK_TYPE' : 'DEFECT_TYPE',
          entityId: created.id,
          newValue: toJsonValue({ code, name }),
        });
        return created;
      });
    } catch (error) {
      if (isPrismaUniqueConflict(error)) {
        throw new DuplicateValueError('Код уже используется');
      }
      throw error;
    }
  }

  private async updateCoded(
    model: 'workType' | 'defectType',
    id: string,
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(codedReferenceWriteSchema, body);
    if (!input.expectedVersion) {
      throw new ValidationError('expectedVersion', 'Укажите expectedVersion');
    }
    const code = normalizeReferenceCode(input.code);
    const name = normalizeReferenceName(input.name);
    const ctx = actorContext(actor, request);
    return this.prisma.client.$transaction(async (tx) => {
      const coded = codedDelegate(tx, model);
      const current = await coded.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      if (current.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const updated = await coded.updateMany({
        where: { id, version: input.expectedVersion },
        data: {
          code,
          name,
          sortOrder: input.sortOrder ?? current.sortOrder,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      await writeAuditLog(tx, {
        ...ctx,
        action: 'REFERENCE_UPDATED',
        entityType: model === 'workType' ? 'WORK_TYPE' : 'DEFECT_TYPE',
        entityId: id,
        oldValue: toJsonValue({ code: current.code, name: current.name }),
        newValue: toJsonValue({ code, name }),
      });
      return coded.findUniqueOrThrow({ where: { id } });
    });
  }

  private async setArchived(
    kind: ReferenceKind,
    id: string,
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
    archive: boolean,
  ) {
    const input = parseCommandBody(versionedReasonSchema, body);
    const ctx = actorContext(actor, request);
    return this.prisma.client.$transaction(async (tx) => {
      const catalog = catalogDelegate(tx, kind);
      const current = await catalog.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      if (current.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const updated = await catalog.updateMany({
        where: { id, version: input.expectedVersion },
        data: {
          active: !archive,
          archivedAt: archive ? new Date() : null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      await writeAuditLog(tx, {
        ...ctx,
        action: archive ? 'REFERENCE_ARCHIVED' : 'REFERENCE_RESTORED',
        entityType: entityTypeOf(kind),
        entityId: id,
        oldValue: toJsonValue({ active: current.active }),
        newValue: toJsonValue({ active: !archive }),
        reason: input.reason ?? null,
      });
      return catalog.findUniqueOrThrow({ where: { id } });
    });
  }

  private async exists(kind: ReferenceKind, id: string): Promise<boolean> {
    const row = await catalogDelegate(this.prisma.client, kind).findUnique({
      where: { id },
      select: { id: true },
    });
    return Boolean(row);
  }

  private async mutateVersioned(
    model: 'propertyObject',
    id: string,
    expectedVersion: number,
    actor: AuthenticatedUser,
    request: FastifyRequest,
    options: {
      data: Prisma.PropertyObjectUpdateManyMutationInput;
      entityType: string;
      snapshot: (row: { name: string; address: string | null }) => unknown;
      nextSnapshot: unknown;
    },
  ) {
    const ctx = actorContext(actor, request);
    return this.prisma.client.$transaction(async (tx) => {
      const current = await tx[model].findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      if (current.version !== expectedVersion) {
        throw new StaleWriteError();
      }
      const updated = await tx[model].updateMany({
        where: { id, version: expectedVersion },
        data: { ...options.data, version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      await writeAuditLog(tx, {
        ...ctx,
        action: 'REFERENCE_UPDATED',
        entityType: options.entityType,
        entityId: id,
        oldValue: toJsonValue(options.snapshot(current)),
        newValue: toJsonValue(options.nextSnapshot),
      });
      return tx[model].findUniqueOrThrow({ where: { id } });
    });
  }
}

interface ListInput {
  page: number;
  pageSize: number;
  status: 'ACTIVE' | 'ARCHIVED' | 'ALL';
  search: string;
}

function activeWhere(status: ListInput['status']) {
  if (status === 'ACTIVE') {
    return { active: true };
  }
  if (status === 'ARCHIVED') {
    return { active: false };
  }
  return {};
}

function pageMeta(input: ListInput, totalCount: number) {
  return {
    page: input.page,
    pageSize: input.pageSize,
    totalCount,
    totalPages: totalCount === 0 ? 0 : Math.ceil(totalCount / input.pageSize),
  };
}

function optionalDate(value: string | null | undefined, field: string): Date | null {
  const parsed = parseOptionalCalendarDate(value, field);
  return parsed ? calendarDateToUtcNoon(parsed) : null;
}

function entityTypeOf(kind: ReferenceKind): string {
  switch (kind) {
    case 'property-objects':
      return 'PROPERTY_OBJECT';
    case 'organizations':
      return 'ORGANIZATION';
    case 'work-types':
      return 'WORK_TYPE';
    case 'defect-types':
      return 'DEFECT_TYPE';
  }
}

interface CodedRow {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  active: boolean;
  version: number;
  archivedAt: Date | null;
}

interface CodedDelegate {
  count: (args: { where: object }) => Promise<number>;
  findMany: (args: object) => Promise<CodedRow[]>;
  findUnique: (args: { where: { id: string } }) => Promise<CodedRow | null>;
  findUniqueOrThrow: (args: { where: { id: string } }) => Promise<CodedRow>;
  create: (args: { data: { code: string; name: string; sortOrder: number } }) => Promise<CodedRow>;
  updateMany: (args: { where: object; data: object }) => Promise<{ count: number }>;
  aggregate: (args: {
    _max: { sortOrder: true };
  }) => Promise<{ _max: { sortOrder: number | null } }>;
}

interface CatalogRow {
  id: string;
  active: boolean;
  version: number;
}

interface CatalogDelegate {
  findUnique: (args: { where: { id: string }; select?: object }) => Promise<CatalogRow | null>;
  findUniqueOrThrow: (args: { where: { id: string } }) => Promise<CatalogRow>;
  updateMany: (args: { where: object; data: object }) => Promise<{ count: number }>;
}

function codedDelegate(
  client: { workType: unknown; defectType: unknown },
  model: 'workType' | 'defectType',
): CodedDelegate {
  return client[model] as CodedDelegate;
}

function catalogDelegate(
  client: {
    propertyObject: unknown;
    organization: unknown;
    workType: unknown;
    defectType: unknown;
  },
  kind: ReferenceKind,
): CatalogDelegate {
  switch (kind) {
    case 'property-objects':
      return client.propertyObject as CatalogDelegate;
    case 'organizations':
      return client.organization as CatalogDelegate;
    case 'work-types':
      return client.workType as CatalogDelegate;
    case 'defect-types':
      return client.defectType as CatalogDelegate;
  }
}
