import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  codedReferenceWriteSchema,
  constructionWorkProfileWriteSchema,
  organizationWriteSchema,
  propertyObjectWriteSchema,
  referenceListQuerySchema,
  versionedReasonSchema,
} from '@sgr-registry/contracts';
import {
  BUSINESS_TIME_ZONE,
  calendarDateToUtcNoon,
  DuplicateDirectoryRecordError,
  DuplicateValueError,
  StaleWriteError,
  assertCaseInsensitiveUnique,
  foldKey,
  calendarDateInTimeZone,
  generateCodedReferenceCode,
  isValidEmail,
  normalizeOptionalContact,
  normalizeOptionalReferenceCode,
  normalizeOptionalText,
  normalizeOrganizationUnp,
  normalizeReferenceName,
  parseOptionalCalendarDate,
  ValidationError,
  assertOrganizationNotDuplicate,
  canManageConstructionWorkDirectory,
  canManageReferenceData,
  isNameOnlyWorkSupplier,
  REFERENCE_ADDRESS_MAX,
} from '@sgr-registry/domain';
import type { Prisma } from '@sgr-registry/database';
import {
  createPropertyObjectViaDefiner,
  updatePropertyObjectViaDefiner,
} from '@sgr-registry/database';
import { notifyOrganizationIncomplete, OutboxWriter } from '@sgr-registry/jobs';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { PrismaService } from '../auth/prisma.tokens.js';
import { toJsonValue, writeAuditLog } from '../common/audit-writer.js';
import { isPrismaUniqueConflict, parseCommandBody } from '../common/command-body.js';
import { actorContext } from '../common/request-context.js';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyWhereAfter,
} from '../common/history-cursor.js';
import { syncObjectEngineers } from './sync-object-engineers.js';

export type ReferenceKind =
  | 'property-objects'
  | 'organizations'
  | 'work-types'
  | 'defect-types'
  | 'construction-work-organizations';

@Injectable()
export class ReferenceDataService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
  ) {}

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
    if (kind === 'construction-work-organizations') {
      return this.listConstructionWorkProfiles({ page, pageSize, status, search });
    }
    return this.listCoded('defectType', { page, pageSize, status, search });
  }

  async create(
    kind: ReferenceKind,
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    if (kind === 'construction-work-organizations') {
      throw new ForbiddenException('Недостаточно прав');
    }
    if (!canManageReferenceData(actor.role) && kind !== 'organizations') {
      throw new ForbiddenException('Недостаточно прав');
    }
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
    if (kind === 'construction-work-organizations') {
      if (!canManageConstructionWorkDirectory(actor.role)) {
        throw new ForbiddenException('Недостаточно прав');
      }
      return this.updateConstructionWorkProfile(id, actor, body, request);
    }
    if (!canManageReferenceData(actor.role)) {
      throw new ForbiddenException('Недостаточно прав');
    }
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

  async remove(
    kind: ReferenceKind,
    id: string,
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    if (kind === 'construction-work-organizations') {
      if (!canManageConstructionWorkDirectory(actor.role)) {
        throw new ForbiddenException('Недостаточно прав');
      }
    } else if (!canManageReferenceData(actor.role)) {
      throw new ForbiddenException('Недостаточно прав');
    }
    const input = parseCommandBody(versionedReasonSchema, body);
    const ctx = actorContext(actor, request);
    try {
      await this.prisma.client.$transaction(async (tx) => {
        if (kind === 'construction-work-organizations') {
          const current = await tx.constructionWorkProfile.findUnique({
            where: { id },
            include: { organization: { select: { officialName: true } } },
          });
          if (!current) {
            throw new NotFoundException('Запись не найдена');
          }
          if (current.version !== input.expectedVersion) {
            throw new StaleWriteError();
          }
          await writeAuditLog(tx, {
            ...ctx,
            action: 'REFERENCE_DELETED',
            entityType: 'CONSTRUCTION_WORK_PROFILE',
            entityId: id,
            oldValue: toJsonValue({
              officialName: current.organization.officialName,
              workSupplierOnObject: current.workSupplierOnObject,
              workExecution: current.workExecution,
            }),
            reason: input.reason ?? null,
          });
          const deleted = await tx.constructionWorkProfile.deleteMany({
            where: { id, version: input.expectedVersion },
          });
          if (deleted.count !== 1) {
            throw new StaleWriteError();
          }
          return;
        }
        if (kind === 'property-objects') {
          const current = await tx.propertyObject.findUnique({ where: { id } });
          if (!current) {
            throw new NotFoundException('Запись не найдена');
          }
          if (current.version !== input.expectedVersion) {
            throw new StaleWriteError();
          }
          await tx.propertyObjectEngineer.deleteMany({ where: { propertyObjectId: id } });
          await writeAuditLog(tx, {
            ...ctx,
            action: 'REFERENCE_DELETED',
            entityType: 'PROPERTY_OBJECT',
            entityId: id,
            oldValue: toJsonValue({ name: current.name, address: current.address }),
            reason: input.reason ?? null,
          });
          const deleted = await tx.propertyObject.deleteMany({
            where: { id, version: input.expectedVersion },
          });
          if (deleted.count !== 1) {
            throw new StaleWriteError();
          }
          return;
        }
        if (kind === 'organizations') {
          const current = await tx.organization.findUnique({ where: { id } });
          if (!current) {
            throw new NotFoundException('Запись не найдена');
          }
          if (current.version !== input.expectedVersion) {
            throw new StaleWriteError();
          }
          await tx.organizationRoleAssignment.deleteMany({ where: { organizationId: id } });
          await tx.organizationWorkType.deleteMany({ where: { organizationId: id } });
          await writeAuditLog(tx, {
            ...ctx,
            action: 'REFERENCE_DELETED',
            entityType: 'ORGANIZATION',
            entityId: id,
            oldValue: toJsonValue({ officialName: current.officialName }),
            reason: input.reason ?? null,
          });
          const deleted = await tx.organization.deleteMany({
            where: { id, version: input.expectedVersion },
          });
          if (deleted.count !== 1) {
            throw new StaleWriteError();
          }
          return;
        }
        if (kind === 'work-types') {
          const current = await tx.workType.findUnique({ where: { id } });
          if (!current) {
            throw new NotFoundException('Запись не найдена');
          }
          if (current.version !== input.expectedVersion) {
            throw new StaleWriteError();
          }
          await tx.organizationWorkType.deleteMany({ where: { workTypeId: id } });
          await writeAuditLog(tx, {
            ...ctx,
            action: 'REFERENCE_DELETED',
            entityType: 'WORK_TYPE',
            entityId: id,
            oldValue: toJsonValue({ code: current.code, name: current.name }),
            reason: input.reason ?? null,
          });
          const deleted = await tx.workType.deleteMany({
            where: { id, version: input.expectedVersion },
          });
          if (deleted.count !== 1) {
            throw new StaleWriteError();
          }
          return;
        }
        const current = await tx.defectType.findUnique({ where: { id } });
        if (!current) {
          throw new NotFoundException('Запись не найдена');
        }
        if (current.version !== input.expectedVersion) {
          throw new StaleWriteError();
        }
        await writeAuditLog(tx, {
          ...ctx,
          action: 'REFERENCE_DELETED',
          entityType: 'DEFECT_TYPE',
          entityId: id,
          oldValue: toJsonValue({ code: current.code, name: current.name }),
          reason: input.reason ?? null,
        });
        const deleted = await tx.defectType.deleteMany({
          where: { id, version: input.expectedVersion },
        });
        if (deleted.count !== 1) {
          throw new StaleWriteError();
        }
      });
    } catch (error) {
      if (isReferenceInUse(error)) {
        throw new ValidationError(
          'id',
          'Запись используется в актах или других данных и не может быть удалена.',
        );
      }
      throw error;
    }
    return { id };
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
          include: {
            user: {
              select: {
                id: true,
                lastName: true,
                firstName: true,
                middleName: true,
                fullName: true,
                status: true,
              },
            },
          },
        },
      },
      orderBy: [{ nameSortKey: 'asc' }, { id: 'asc' }],
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
          lastName: row.user.lastName,
          firstName: row.user.firstName,
          middleName: row.user.middleName,
          fullName: row.user.fullName,
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

  private async listConstructionWorkProfiles(input: ListInput) {
    const where: Prisma.ConstructionWorkProfileWhereInput = {
      organization: {
        ...activeWhere(input.status),
        ...(input.search.length >= 2
          ? { officialName: { contains: input.search, mode: 'insensitive' } }
          : {}),
      },
    };
    const totalCount = await this.prisma.client.constructionWorkProfile.count({ where });
    const items = await this.prisma.client.constructionWorkProfile.findMany({
      where,
      include: {
        organization: { select: { officialName: true, active: true, archivedAt: true } },
      },
      orderBy: [{ organization: { officialName: 'asc' } }, { id: 'asc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    });
    return {
      items: items.map((item) => ({
        id: item.id,
        officialName: item.organization.officialName,
        workSupplierOnObject: item.workSupplierOnObject,
        workExecution: item.workExecution,
        active: item.organization.active,
        version: item.version,
        archivedAt: item.organization.archivedAt?.toISOString() ?? null,
      })),
      ...pageMeta(input, totalCount),
    };
  }

  private async updateConstructionWorkProfile(
    id: string,
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(constructionWorkProfileWriteSchema, body);
    const workSupplierOnObject = normalizeOptionalText(
      input.workSupplierOnObject,
      'workSupplierOnObject',
      1000,
    );
    const workExecution = normalizeOptionalText(input.workExecution, 'workExecution', 1000);
    const ctx = actorContext(actor, request);
    return this.prisma.client.$transaction(async (tx) => {
      const current = await tx.constructionWorkProfile.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      if (current.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const updated = await tx.constructionWorkProfile.updateMany({
        where: { id, version: input.expectedVersion },
        data: {
          workSupplierOnObject,
          workExecution,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      await writeAuditLog(tx, {
        ...ctx,
        action: 'REFERENCE_UPDATED',
        entityType: 'CONSTRUCTION_WORK_PROFILE',
        entityId: id,
        oldValue: toJsonValue({
          workSupplierOnObject: current.workSupplierOnObject,
          workExecution: current.workExecution,
        }),
        newValue: toJsonValue({ workSupplierOnObject, workExecution }),
      });
      return tx.constructionWorkProfile.findUniqueOrThrow({
        where: { id },
        include: { organization: { select: { officialName: true, active: true } } },
      });
    });
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
      orderBy:
        model === 'defectType'
          ? [{ nameSortKey: 'asc' as const }, { id: 'asc' as const }]
          : [{ sortOrder: 'asc' as const }, { name: 'asc' as const }],
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
    const address = normalizeOptionalText(input.address, 'address', REFERENCE_ADDRESS_MAX);
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
      throw mapPropertyObjectWriteError(error);
    }
  }

  private async updatePropertyObject(
    id: string,
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(propertyObjectWriteSchema, body);
    const expectedVersion = input.expectedVersion;
    if (!expectedVersion) {
      throw new ValidationError('expectedVersion', 'Укажите expectedVersion');
    }
    const name = normalizeReferenceName(input.name);
    const address = normalizeOptionalText(input.address, 'address', REFERENCE_ADDRESS_MAX);
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const current = await tx.propertyObject.findUnique({ where: { id } });
        if (!current) {
          throw new NotFoundException('Запись не найдена');
        }
        const ctx = actorContext(actor, request);
        const updated = await updatePropertyObjectViaDefiner(tx, {
          id,
          expectedVersion,
          name,
          address,
          active: null,
          actorUserId: actor.id,
          actorName: actor.fullName,
          requestId: ctx.requestId,
        });
        if (input.responsibleEngineerIds) {
          await syncObjectEngineers(tx, {
            objectId: id,
            objectActive: updated.active,
            engineerIds: input.responsibleEngineerIds,
            ctx,
          });
        }
        return tx.propertyObject.findUniqueOrThrow({ where: { id } });
      });
    } catch (error) {
      throw mapPropertyObjectWriteError(error);
    }
  }

  private async createOrganization(
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(organizationWriteSchema, body);
    const officialName = normalizeReferenceName(input.officialName, 'officialName');
    const unp = normalizeOrganizationUnp(input.unp);
    const email = normalizeOptionalContact(input.email, 'email');
    if (email && !isValidEmail(email)) {
      throw new ValidationError('email', 'Некорректный адрес электронной почты');
    }
    const postalAddress = normalizeOptionalText(
      input.postalAddress,
      'postalAddress',
      REFERENCE_ADDRESS_MAX,
    );
    const phone = normalizeOptionalContact(input.phone, 'phone');
    const contactPerson = normalizeOptionalContact(input.contactPerson, 'contactPerson');
    const nameOnlySupplier = isNameOnlyWorkSupplier({
      roles: input.roles,
      unp,
      postalAddress,
      email,
      phone,
      contactPerson,
    });
    if (!canManageReferenceData(actor.role) && !nameOnlySupplier) {
      throw new ForbiddenException('Недостаточно прав');
    }
    const ctx = actorContext(actor, request);
    const details = { officialName, unp, postalAddress, email, phone, contactPerson };
    const roles = input.roles ?? [];
    const deferSupplierNotice =
      roles.includes('ALTERNATIVE_CONTRACTOR') && !roles.includes('LIABLE_CONTRACTOR');
    const outboxIds: string[] = [];
    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260903, 15)`;
        const existing = await tx.organization.findMany({
          select: { id: true, officialName: true, unp: true },
        });
        assertOrganizationNotDuplicate({ officialName, unp }, existing);
        const createdRow = await tx.organization.create({
          data: {
            officialName,
            unp,
            postalAddress,
            email,
            phone,
            contactPerson,
            roles: input.roles ? { create: input.roles.map((role) => ({ role })) } : undefined,
          },
          include: { roles: true },
        });
        await writeAuditLog(tx, {
          ...ctx,
          action: 'ORGANIZATION_CREATED',
          entityType: 'ORGANIZATION',
          entityId: createdRow.id,
          newValue: toJsonValue({
            officialName,
            unp: unp ? 'set' : null,
            roles: input.roles ?? [],
          }),
        });
        if (!deferSupplierNotice) {
          outboxIds.push(
            ...(await notifyOrganizationIncomplete(this.outboxWriter, tx, {
              organizationId: createdRow.id,
              details,
              roles: input.roles,
              actorUserId: actor.id,
            })),
          );
        }
        return createdRow;
      });
      await this.outboxWriter.enqueue(outboxIds);
      return created;
    } catch (error) {
      if (isPrismaUniqueConflict(error)) {
        const again = await this.prisma.client.organization.findMany({
          select: { id: true, officialName: true, unp: true },
        });
        assertOrganizationNotDuplicate({ officialName, unp }, again);
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
    const unp = normalizeOrganizationUnp(input.unp);
    const email = normalizeOptionalContact(input.email, 'email');
    if (email && !isValidEmail(email)) {
      throw new ValidationError('email', 'Некорректный адрес электронной почты');
    }
    const postalAddress = normalizeOptionalText(
      input.postalAddress,
      'postalAddress',
      REFERENCE_ADDRESS_MAX,
    );
    const phone = normalizeOptionalContact(input.phone, 'phone');
    const contactPerson = normalizeOptionalContact(input.contactPerson, 'contactPerson');
    const ctx = actorContext(actor, request);
    const outboxIds: string[] = [];
    const updated = await this.prisma.client.$transaction(async (tx) => {
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
      const others = await tx.organization.findMany({
        where: { id: { not: id } },
        select: { id: true, officialName: true, unp: true },
      });
      assertOrganizationNotDuplicate({ officialName, unp }, others);
      const written = await tx.organization.updateMany({
        where: { id, version: input.expectedVersion },
        data: {
          officialName,
          unp,
          postalAddress,
          email,
          phone,
          contactPerson,
          version: { increment: 1 },
        },
      });
      if (written.count !== 1) {
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
      const details = { officialName, unp, postalAddress, email, phone, contactPerson };
      const roles = input.roles ?? current.roles.map((row) => row.role);
      outboxIds.push(
        ...(await notifyOrganizationIncomplete(this.outboxWriter, tx, {
          organizationId: id,
          details,
          roles,
          actorUserId: actor.id,
        })),
      );
      return tx.organization.findUniqueOrThrow({ where: { id }, include: { roles: true } });
    });
    await this.outboxWriter.enqueue(outboxIds);
    return updated;
  }

  private async createCoded(
    model: 'workType' | 'defectType',
    actor: AuthenticatedUser,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(codedReferenceWriteSchema, body);
    const name = normalizeReferenceName(input.name);
    const ctx = actorContext(actor, request);
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260903, ${model === 'workType' ? 16 : 17})`;
        const client = codedDelegate(tx, model);
        const existing = await client.findMany({ select: { id: true, code: true, name: true } });
        const nameDuplicate = existing.find((item) => foldKey(item.name) === foldKey(name));
        if (nameDuplicate) {
          throw new DuplicateDirectoryRecordError('Такое значение уже существует', {
            id: nameDuplicate.id,
            label: nameDuplicate.name,
          });
        }
        const maxSort = await client.aggregate({ _max: { sortOrder: true } });
        const sortOrder = input.sortOrder ?? (maxSort._max.sortOrder ?? 0) + 1;
        const code =
          normalizeOptionalReferenceCode(input.code) ??
          generateCodedReferenceCode(
            model === 'workType' ? 'WT' : 'DT',
            name,
            existing.map((item) => item.code),
            sortOrder,
          );
        assertCaseInsensitiveUnique(
          code,
          existing.map((item) => item.code),
          'Код уже используется',
        );
        const created = await client.create({
          data: {
            code,
            name,
            sortOrder,
          },
        });
        await writeAuditLog(tx, {
          ...ctx,
          action: model === 'workType' ? 'WORK_TYPE_CREATED' : 'DEFECT_TYPE_CREATED',
          entityType: model === 'workType' ? 'WORK_TYPE' : 'DEFECT_TYPE',
          entityId: created.id,
          newValue: toJsonValue({ code, name }),
        });
        return created;
      });
    } catch (error) {
      if (error instanceof DuplicateDirectoryRecordError || error instanceof DuplicateValueError) {
        throw error;
      }
      if (isPrismaUniqueConflict(error) || /23505|P2002/.test(String(error))) {
        const again = await codedDelegate(this.prisma.client, model).findMany({
          select: { id: true, name: true },
        });
        const nameDuplicate = again.find((item) => foldKey(item.name) === foldKey(name));
        if (nameDuplicate) {
          throw new DuplicateDirectoryRecordError('Такое значение уже существует', {
            id: nameDuplicate.id,
            label: nameDuplicate.name,
          });
        }
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
    const code = normalizeOptionalReferenceCode(input.code);
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
      const nextCode = code ?? current.code;
      const updated = await coded.updateMany({
        where: { id, version: input.expectedVersion },
        data: {
          code: nextCode,
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
        newValue: toJsonValue({ code: nextCode, name }),
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
    if (kind === 'construction-work-organizations') {
      throw new ForbiddenException('Недостаточно прав');
    }
    const input = parseCommandBody(versionedReasonSchema, body);
    const ctx = actorContext(actor, request);
    if (kind === 'property-objects') {
      try {
        return await this.prisma.client.$transaction(async (tx) => {
          const current = await tx.propertyObject.findUnique({ where: { id } });
          if (!current) {
            throw new NotFoundException('Запись не найдена');
          }
          return updatePropertyObjectViaDefiner(tx, {
            id,
            expectedVersion: input.expectedVersion,
            name: current.name,
            address: current.address,
            active: !archive,
            actorUserId: actor.id,
            actorName: actor.fullName,
            requestId: ctx.requestId,
          });
        });
      } catch (error) {
        throw mapPropertyObjectWriteError(error);
      }
    }
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
    if (kind === 'construction-work-organizations') {
      const row = await this.prisma.client.constructionWorkProfile.findUnique({
        where: { id },
        select: { id: true },
      });
      return Boolean(row);
    }
    const row = await catalogDelegate(this.prisma.client, kind).findUnique({
      where: { id },
      select: { id: true },
    });
    return Boolean(row);
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
    case 'construction-work-organizations':
      return 'CONSTRUCTION_WORK_PROFILE';
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
    case 'construction-work-organizations':
      throw new ForbiddenException('Недостаточно прав');
  }
}

function isReferenceInUse(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : '';
  return code === 'P2003' || code === '23503' || /23503|foreign key/i.test(message);
}

function mapPropertyObjectWriteError(error: unknown): never {
  if (
    error instanceof DuplicateValueError ||
    error instanceof ValidationError ||
    error instanceof StaleWriteError ||
    error instanceof NotFoundException ||
    error instanceof ForbiddenException
  ) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
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
  throw error instanceof Error ? error : new Error(String(error));
}
