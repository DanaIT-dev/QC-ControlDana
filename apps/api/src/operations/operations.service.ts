import { randomUUID } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  addDefectRequestSchema,
  archiveProposalRequestSchema,
  completeDefectRequestSchema,
  createActRequestSchema,
  historyQuerySchema,
  patchActHeaderRequestSchema,
  patchDeadlinesRequestSchema,
  reopenDefectRequestSchema,
  replaceAssignmentsRequestSchema,
  restoreProposalRequestSchema,
  startActRequestSchema,
  upsertProposalRequestSchema,
  type ProposalSlot,
} from '@sgr-registry/contracts';
import { allocateActNumber, Prisma, startActViaDefiner } from '@sgr-registry/database';
import {
  ASSIGNABLE_ENGINEER_ROLE,
  BUSINESS_TIME_ZONE,
  IdempotencyConflictError,
  InvalidTransitionError,
  StaleWriteError,
  ValidationError,
  assertAtLeastOneDefectItem,
  assertAtLeastOneEngineer,
  assertDeadlineFieldAllowed,
  assertUniqueIds,
  actStatusLabel,
  calendarDateInTimeZone,
  calendarDateToUtcNoon,
  canViewAssignedHistory,
  canViewFullHistory,
  canViewHistory,
  completeDefectItem,
  computeActStatus,
  createDefectItem,
  deadlineChangeRequiresReason,
  deadlineFieldsForRole,
  historyVisibleToRole,
  isObjectScopedRole,
  isProposalBcEvent,
  normalizeClaimDetails,
  normalizeDocumentRef,
  normalizeLocation,
  normalizeNotes,
  normalizeRequiredReason,
  parseActIssuedOn,
  parseOptionalDeadline,
  parseProposalAmount,
  reopenDefectItem,
  shapeHistoryForRole,
  visibleProposalSlots,
  isBusinessStaffRole,
} from '@sgr-registry/domain';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../auth/prisma.tokens';
import { toJsonValue, writeAuditLog } from '../common/audit-writer';
import { isPrismaUniqueConflict, parseCommandBody } from '../common/command-body';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyWhereAfter,
} from '../common/history-cursor';
import { actorContext, canonicalRequestHash, readIdempotencyKey } from '../common/request-context';
import { RegistryAccessScope } from '../registry/registry-access-scope';
import {
  notifyDeadlineChanges,
  notifyDefectStatus,
  notifyResponsibleAssigned,
  OutboxWriter,
  revokeRecipientsForUsers,
  syncSlaClocks,
  warningDaysOf,
} from '@sgr-registry/jobs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class OperationsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
  ) {}

  async lookups(user: AuthenticatedUser) {
    const scope = new RegistryAccessScope(user);
    const objectWhere: Prisma.PropertyObjectWhereInput = {
      active: true,
      ...(scope.objectScoped ? { engineers: { some: scope.assignedObjectRelationWhere() } } : {}),
    };
    const [objects, customers, liable, alternatives, defectTypes, workTypes, engineers] =
      await Promise.all([
        this.prisma.client.propertyObject.findMany({
          where: objectWhere,
          select: {
            id: true,
            name: true,
            address: true,
            engineers: {
              where: { unassignedAt: null },
              select: { userId: true },
            },
          },
          orderBy: { name: 'asc' },
        }),
        this.prisma.client.organization.findMany({
          where: { active: true, roles: { some: { role: 'CUSTOMER' } } },
          select: { id: true, officialName: true },
          orderBy: { officialName: 'asc' },
        }),
        this.prisma.client.organization.findMany({
          where: { active: true, roles: { some: { role: 'LIABLE_CONTRACTOR' } } },
          select: { id: true, officialName: true },
          orderBy: { officialName: 'asc' },
        }),
        this.prisma.client.organization.findMany({
          where: { active: true, roles: { some: { role: 'ALTERNATIVE_CONTRACTOR' } } },
          select: { id: true, officialName: true },
          orderBy: { officialName: 'asc' },
        }),
        this.prisma.client.defectType.findMany({
          where: { active: true },
          select: { id: true, name: true, code: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        this.prisma.client.workType.findMany({
          where: { active: true },
          select: { id: true, name: true, code: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        this.prisma.client.user.findMany({
          where: { status: 'ACTIVE', role: ASSIGNABLE_ENGINEER_ROLE },
          select: { id: true, fullName: true, email: true },
          orderBy: { fullName: 'asc' },
        }),
      ]);
    const assignedEngineerIds = new Set(
      objects.flatMap((object) => object.engineers.map((row) => row.userId)),
    );
    return {
      propertyObjects: objects.map((object) => ({
        id: object.id,
        name: object.name,
        address: object.address ?? '',
        responsibleEngineerIds: object.engineers.map((row) => row.userId),
      })),
      customers,
      liableOrganizations: liable,
      alternativeContractors: alternatives,
      defectTypes,
      workTypes,
      responsibleEngineers: scope.objectScoped
        ? engineers.filter((engineer) => assignedEngineerIds.has(engineer.id))
        : engineers,
      canViewLookups: true,
      actorRole: user.role,
    };
  }

  async createAct(user: AuthenticatedUser, body: unknown, request: FastifyRequest) {
    const input = parseCommandBody(createActRequestSchema, body);
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) {
      throw new ValidationError('Idempotency-Key', 'Ключ идемпотентности обязателен');
    }
    const requestHash = canonicalRequestHash(input);
    const existing = await this.prisma.client.idempotencyRecord.findUnique({
      where: {
        actorUserId_command_idempotencyKey: {
          actorUserId: user.id,
          command: 'CREATE_ACT',
          idempotencyKey,
        },
      },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new IdempotencyConflictError();
      }
      return existing.responseBody;
    }
    assertAtLeastOneDefectItem(input.defectItems.length);
    const ctx = actorContext(user, request);
    const issuedOn = parseActIssuedOn(input.issuedOn);
    const issuedAt = calendarDateToUtcNoon(issuedOn);
    const outboxIds: string[] = [];
    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        await tx.idempotencyRecord.create({
          data: {
            actorUserId: user.id,
            command: 'CREATE_ACT',
            idempotencyKey,
            requestHash,
            statusCode: 201,
            responseBody: {},
          },
        });
        await this.assertCreatableObject(tx, user, input.objectId);
        await this.assertActHeaderRefs(tx, input.objectId, input.customerOrganizationId);
        const number = await allocateActNumber(tx, input.formCode, issuedAt);
        const act = await tx.act.create({
          data: {
            officialNumber: number.officialNumber,
            formCode: number.formCode,
            year: number.year,
            sequence: number.sequence,
            objectId: input.objectId,
            customerOrganizationId: input.customerOrganizationId,
            issuedOn: issuedAt,
            signedDocumentRef: normalizeDocumentRef(input.signedDocumentRef),
            status: 'NEW',
          },
        });
        const defectIds: string[] = [];
        for (const item of input.defectItems) {
          const defectId = await this.insertDefect(tx, act.id, item, user, outboxIds);
          defectIds.push(defectId);
        }
        const payload = { id: act.id, officialNumber: act.officialNumber, version: act.version };
        await writeAuditLog(tx, {
          ...ctx,
          action: 'ACT_CREATED',
          entityType: 'ACT',
          entityId: act.id,
          newValue: toJsonValue({
            officialNumber: act.officialNumber,
            formCode: act.formCode,
            objectId: act.objectId,
            customerOrganizationId: act.customerOrganizationId,
            issuedOn,
            defectItemIds: defectIds,
          }),
        });
        await tx.idempotencyRecord.update({
          where: {
            actorUserId_command_idempotencyKey: {
              actorUserId: user.id,
              command: 'CREATE_ACT',
              idempotencyKey,
            },
          },
          data: { responseBody: payload, resourceId: act.id },
        });
        return payload;
      });
      await this.outboxWriter.enqueue(outboxIds);
      return created;
    } catch (error) {
      if (isPrismaUniqueConflict(error)) {
        const again = await this.prisma.client.idempotencyRecord.findUnique({
          where: {
            actorUserId_command_idempotencyKey: {
              actorUserId: user.id,
              command: 'CREATE_ACT',
              idempotencyKey,
            },
          },
        });
        if (again) {
          if (again.requestHash !== requestHash) {
            throw new IdempotencyConflictError();
          }
          return again.responseBody;
        }
      }
      throw error;
    }
  }

  async patchHeader(
    user: AuthenticatedUser,
    actId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(patchActHeaderRequestSchema, body);
    const ctx = actorContext(user, request);
    await this.requireVisibleAct(user, actId);
    return this.prisma.client.$transaction(async (tx) => {
      const current = await this.requireVisibleActOn(tx, user, actId);
      if (current.status === 'CANCELLED') {
        throw new NotFoundException('Запись не найдена');
      }
      if (current.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const nextObjectId = input.objectId ?? current.objectId;
      await this.assertCreatableObject(tx, user, nextObjectId);
      if (input.objectId) {
        await this.assertActHeaderRefs(
          tx,
          input.objectId,
          input.customerOrganizationId ?? current.customerOrganizationId,
        );
      } else if (input.customerOrganizationId) {
        await this.assertActHeaderRefs(tx, current.objectId, input.customerOrganizationId);
      }
      const issuedOn = input.issuedOn
        ? calendarDateToUtcNoon(parseActIssuedOn(input.issuedOn))
        : current.issuedOn;
      const updated = await tx.act.updateMany({
        where: { id: actId, version: input.expectedVersion },
        data: {
          objectId: input.objectId ?? current.objectId,
          customerOrganizationId: input.customerOrganizationId ?? current.customerOrganizationId,
          issuedOn,
          signedDocumentRef:
            input.signedDocumentRef === undefined
              ? current.signedDocumentRef
              : normalizeDocumentRef(input.signedDocumentRef),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      const fresh = await tx.act.findUniqueOrThrow({ where: { id: actId } });
      await writeAuditLog(tx, {
        ...ctx,
        action: 'ACT_HEADER_UPDATED',
        entityType: 'ACT',
        entityId: actId,
        oldValue: toJsonValue({
          objectId: current.objectId,
          customerOrganizationId: current.customerOrganizationId,
          issuedOn: calendarDateInTimeZone(current.issuedOn),
          signedDocumentRef: current.signedDocumentRef,
        }),
        newValue: toJsonValue({
          objectId: fresh.objectId,
          customerOrganizationId: fresh.customerOrganizationId,
          issuedOn: calendarDateInTimeZone(fresh.issuedOn),
          signedDocumentRef: fresh.signedDocumentRef,
        }),
      });
      return { id: fresh.id, version: fresh.version };
    });
  }

  async addDefect(user: AuthenticatedUser, actId: string, body: unknown, request: FastifyRequest) {
    const input = parseCommandBody(addDefectRequestSchema, body);
    const ctx = actorContext(user, request);
    await this.requireVisibleAct(user, actId);
    const outboxIds: string[] = [];
    const result = await this.prisma.client.$transaction(async (tx) => {
      const act = await this.requireVisibleActOn(tx, user, actId);
      if (act.status === 'CANCELLED') {
        throw new InvalidTransitionError('Нельзя добавить дефект в аннулированный акт');
      }
      if (act.version !== input.expectedActVersion) {
        throw new StaleWriteError();
      }
      const defectId = await this.insertDefect(tx, actId, input, user, outboxIds);
      const items = await tx.defectItem.findMany({ where: { actId } });
      await tx.act.update({
        where: { id: actId },
        data: {
          status: computeActStatus(
            items.map((row) => ({ status: row.status, active: true })),
            { startedAt: act.startedAt, cancelledAt: act.cancelledAt },
          ),
          version: { increment: 1 },
        },
      });
      await writeAuditLog(tx, {
        ...ctx,
        action: 'DEFECT_ADDED',
        entityType: 'DEFECT_ITEM',
        entityId: defectId,
        parentEntityType: 'ACT',
        parentEntityId: actId,
        newValue: toJsonValue({ location: normalizeLocation(input.location) }),
      });
      return { id: defectId };
    });
    await this.outboxWriter.enqueue(outboxIds);
    return result;
  }

  async replaceAssignments(
    user: AuthenticatedUser,
    defectItemId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(replaceAssignmentsRequestSchema, body);
    const ctx = actorContext(user, request);
    const item = await this.requireVisibleDefect(user, defectItemId);
    const engineerIds = assertUniqueIds(input.responsibleEngineerIds, 'responsibleEngineerIds');
    const liableIds = assertUniqueIds(input.liableOrganizationIds, 'liableOrganizationIds');
    if (engineerIds.length === 0 && !input.confirmRemoveLastEngineer) {
      throw new ValidationError(
        'confirmRemoveLastEngineer',
        'Подтвердите снятие последнего ответственного',
      );
    }
    return this.prisma.client
      .$transaction(async (tx) => {
        const current = await this.requireVisibleDefectOn(tx, user, defectItemId);
        if (current.version !== input.expectedVersion) {
          throw new StaleWriteError();
        }
        await this.assertObjectEngineers(tx, current.act.objectId, engineerIds);
        await this.assertEngineers(tx, engineerIds);
        await this.assertOrganizations(tx, liableIds, true);
        const previousEngineers = await tx.defectItemEngineer.findMany({
          where: { defectItemId },
          select: { userId: true },
        });
        const previousLiable = await tx.defectItemLiableOrganization.findMany({
          where: { defectItemId },
          select: { organizationId: true },
        });
        const updated = await tx.defectItem.updateMany({
          where: { id: defectItemId, version: input.expectedVersion },
          data: { version: { increment: 1 } },
        });
        if (updated.count !== 1) {
          throw new StaleWriteError();
        }
        await tx.defectItemEngineer.deleteMany({ where: { defectItemId } });
        if (engineerIds.length > 0) {
          await tx.defectItemEngineer.createMany({
            data: engineerIds.map((userId) => ({ defectItemId, userId })),
          });
        }
        await tx.defectItemLiableOrganization.deleteMany({ where: { defectItemId } });
        if (liableIds.length > 0) {
          await tx.defectItemLiableOrganization.createMany({
            data: liableIds.map((organizationId) => ({ defectItemId, organizationId })),
          });
        }
        const previousIds = previousEngineers.map((row) => row.userId);
        const added = engineerIds.filter((id) => !previousIds.includes(id));
        const removed = previousIds.filter((id) => !engineerIds.includes(id));
        await revokeRecipientsForUsers(tx, defectItemId, removed);
        const outboxIds = await notifyResponsibleAssigned(this.outboxWriter, tx, {
          actId: item.actId,
          defectItemId,
          userIds: added,
          actorUserId: user.id,
          version: item.version + 1,
        });
        await writeAuditLog(tx, {
          ...ctx,
          action: 'ASSIGNMENTS_REPLACED',
          entityType: 'DEFECT_ITEM',
          entityId: defectItemId,
          parentEntityType: 'ACT',
          parentEntityId: item.actId,
          oldValue: toJsonValue({
            responsibleEngineerIds: previousIds,
            liableOrganizationIds: previousLiable.map((row) => row.organizationId),
          }),
          newValue: toJsonValue({
            responsibleEngineerIds: engineerIds,
            liableOrganizationIds: liableIds,
          }),
        });
        return { id: defectItemId, version: item.version + 1, outboxIds };
      })
      .then(async (result) => {
        await this.outboxWriter.enqueue(result.outboxIds);
        return { id: result.id, version: result.version };
      });
  }

  async patchDeadlines(
    user: AuthenticatedUser,
    defectItemId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(patchDeadlinesRequestSchema, body);
    const ctx = actorContext(user, request);
    const item = await this.requireVisibleDefect(user, defectItemId);
    const allowed = new Set(deadlineFieldsForRole(user.role));
    const changes: Array<{
      field: 'plannedDeadline' | 'claimDeadline' | 'thirdPartyDeadline';
      next: string | null;
      previous: string | null;
    }> = [];
    for (const field of ['plannedDeadline', 'claimDeadline', 'thirdPartyDeadline'] as const) {
      if (input[field] === undefined) {
        continue;
      }
      assertDeadlineFieldAllowed(user.role, field);
      if (!allowed.has(field)) {
        assertDeadlineFieldAllowed(user.role, field);
      }
      const previous = item[field]
        ? calendarDateInTimeZone(item[field] as Date, BUSINESS_TIME_ZONE)
        : null;
      const next = parseOptionalDeadline(input[field], field);
      if (previous !== next) {
        changes.push({ field, next, previous });
      }
    }
    if (changes.length === 0) {
      return { id: defectItemId, version: item.version };
    }
    const needsReason = changes.some((change) =>
      deadlineChangeRequiresReason({ previous: change.previous, next: change.next }),
    );
    if (needsReason) {
      normalizeRequiredReason(input.reason);
    }
    if (item.status === 'COMPLETED') {
      if (!isBusinessStaffRole(user.role)) {
        throw new InvalidTransitionError('Завершённый дефект нельзя изменить');
      }
      if (!input.confirmCompletedEdit) {
        throw new ValidationError(
          'confirmCompletedEdit',
          'Подтвердите изменение срока завершённого дефекта',
        );
      }
      normalizeRequiredReason(input.reason);
    }
    const reason =
      needsReason || input.confirmCompletedEdit ? normalizeRequiredReason(input.reason) : null;
    const previousDeadlines = {
      claimDeadline: item.claimDeadline,
      plannedDeadline: item.plannedDeadline,
      thirdPartyDeadline: item.thirdPartyDeadline,
    };
    const result = await this.prisma.client.$transaction(async (tx) => {
      if (item.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const data: Prisma.DefectItemUpdateManyMutationInput = { version: { increment: 1 } };
      for (const change of changes) {
        data[change.field] = change.next ? calendarDateToUtcNoon(change.next) : null;
      }
      const updated = await tx.defectItem.updateMany({
        where: { id: defectItemId, version: input.expectedVersion },
        data,
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      const fresh = await tx.defectItem.findUniqueOrThrow({ where: { id: defectItemId } });
      const outboxIds = await notifyDeadlineChanges(this.outboxWriter, tx, {
        actId: item.actId,
        defectItemId,
        actorUserId: user.id,
        previous: previousDeadlines,
        next: {
          id: fresh.id,
          status: fresh.status,
          claimDeadline: fresh.claimDeadline,
          plannedDeadline: fresh.plannedDeadline,
          thirdPartyDeadline: fresh.thirdPartyDeadline,
        },
      });
      await writeAuditLog(tx, {
        ...ctx,
        action: 'DEADLINE_UPDATED',
        entityType: 'DEFECT_ITEM',
        entityId: defectItemId,
        parentEntityType: 'ACT',
        parentEntityId: item.actId,
        reason,
        oldValue: toJsonValue(
          Object.fromEntries(changes.map((change) => [change.field, change.previous])),
        ),
        newValue: toJsonValue(
          Object.fromEntries(changes.map((change) => [change.field, change.next])),
        ),
      });
      return { id: fresh.id, version: fresh.version, outboxIds };
    });
    await this.outboxWriter.enqueue(result.outboxIds);
    return { id: result.id, version: result.version };
  }

  async complete(
    user: AuthenticatedUser,
    defectItemId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(completeDefectRequestSchema, body);
    const ctx = actorContext(user, request);
    const item = await this.requireVisibleDefect(user, defectItemId);
    const act = await this.requireVisibleAct(user, item.actId);
    if (act.status === 'NEW' || act.startedAt == null) {
      throw new InvalidTransitionError('Нельзя исполнить дефект до начала работы по акту');
    }
    if (item.status === 'COMPLETED') {
      return { id: item.id, version: item.version, status: item.status };
    }
    const readyAt = input.readyAt
      ? calendarDateToUtcNoon(input.readyAt)
      : calendarDateToUtcNoon(calendarDateInTimeZone(new Date(), BUSINESS_TIME_ZONE));
    const next = completeDefectItem(
      { id: item.id, actId: item.actId, status: item.status, readyAt: item.readyAt },
      { readyAt, now: new Date() },
    );
    let result;
    try {
      result = await this.prisma.client.$transaction(async (tx) => {
        if (item.version !== input.expectedVersion) {
          throw new StaleWriteError();
        }
        const updated = await tx.defectItem.updateMany({
          where: { id: defectItemId, version: input.expectedVersion, status: 'IN_PROGRESS' },
          data: {
            status: 'COMPLETED',
            readyAt: next.readyAt,
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) {
          const latest = await tx.defectItem.findUnique({ where: { id: defectItemId } });
          if (latest?.status === 'COMPLETED') {
            return {
              id: latest.id,
              version: latest.version,
              status: latest.status,
              outboxIds: [] as string[],
            };
          }
          throw new StaleWriteError();
        }
        await this.syncActStatus(tx, item.actId);
        const fresh = await tx.defectItem.findUniqueOrThrow({ where: { id: defectItemId } });
        const outboxIds = await notifyDefectStatus(this.outboxWriter, tx, {
          type: 'DEFECT_COMPLETED',
          actId: item.actId,
          defectItemId,
          actorUserId: user.id,
          defect: {
            id: fresh.id,
            status: fresh.status,
            claimDeadline: fresh.claimDeadline,
            plannedDeadline: fresh.plannedDeadline,
            thirdPartyDeadline: fresh.thirdPartyDeadline,
          },
        });
        await writeAuditLog(tx, {
          ...ctx,
          action: 'DEFECT_COMPLETED',
          entityType: 'DEFECT_ITEM',
          entityId: defectItemId,
          parentEntityType: 'ACT',
          parentEntityId: item.actId,
          oldValue: toJsonValue({ status: 'IN_PROGRESS', readyAt: null }),
          newValue: toJsonValue({
            status: 'COMPLETED',
            readyAt: calendarDateInTimeZone(fresh.readyAt ?? readyAt),
            comment: normalizeNotes(input.comment),
          }),
        });
        return { id: fresh.id, version: fresh.version, status: fresh.status, outboxIds };
      });
    } catch (error) {
      rethrowIfActNotStarted(error);
      throw error;
    }
    await this.outboxWriter.enqueue(result.outboxIds);
    return { id: result.id, version: result.version, status: result.status };
  }

  async startAct(user: AuthenticatedUser, actId: string, body: unknown, request: FastifyRequest) {
    parseCommandBody(startActRequestSchema, body);
    const ctx = actorContext(user, request);
    await this.requireVisibleAct(user, actId);
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const started = await startActViaDefiner(tx, {
          actId,
          requestId: ctx.requestId,
        });
        return {
          id: started.id,
          status: started.status,
          statusLabel: actStatusLabel(started.status),
          version: started.version,
          startedAt: started.startedAt ? started.startedAt.toISOString() : null,
          startedBy:
            started.startedById && started.startedByName
              ? { id: started.startedById, fullName: started.startedByName }
              : null,
        };
      });
    } catch (error) {
      mapStartActError(error);
    }
  }

  async reopen(
    user: AuthenticatedUser,
    defectItemId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(reopenDefectRequestSchema, body);
    const ctx = actorContext(user, request);
    const item = await this.requireVisibleDefect(user, defectItemId);
    const reason = normalizeRequiredReason(input.reason);
    const next = reopenDefectItem(
      { id: item.id, actId: item.actId, status: item.status, readyAt: item.readyAt },
      { reason },
    );
    const result = await this.prisma.client.$transaction(async (tx) => {
      if (item.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const updated = await tx.defectItem.updateMany({
        where: { id: defectItemId, version: input.expectedVersion, status: 'COMPLETED' },
        data: {
          status: next.status,
          readyAt: null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      await this.syncActStatus(tx, item.actId);
      const fresh = await tx.defectItem.findUniqueOrThrow({ where: { id: defectItemId } });
      const outboxIds = await notifyDefectStatus(this.outboxWriter, tx, {
        type: 'DEFECT_REOPENED',
        actId: item.actId,
        defectItemId,
        actorUserId: user.id,
        reopen: true,
        defect: {
          id: fresh.id,
          status: fresh.status,
          claimDeadline: fresh.claimDeadline,
          plannedDeadline: fresh.plannedDeadline,
          thirdPartyDeadline: fresh.thirdPartyDeadline,
        },
      });
      await writeAuditLog(tx, {
        ...ctx,
        action: 'DEFECT_REOPENED',
        entityType: 'DEFECT_ITEM',
        entityId: defectItemId,
        parentEntityType: 'ACT',
        parentEntityId: item.actId,
        reason,
        oldValue: toJsonValue({
          status: 'COMPLETED',
          readyAt: item.readyAt ? calendarDateInTimeZone(item.readyAt) : null,
        }),
        newValue: toJsonValue({ status: 'IN_PROGRESS', readyAt: null }),
      });
      return { id: fresh.id, version: fresh.version, status: fresh.status, outboxIds };
    });
    await this.outboxWriter.enqueue(result.outboxIds);
    return { id: result.id, version: result.version, status: result.status };
  }

  async upsertProposal(
    user: AuthenticatedUser,
    defectItemId: string,
    slot: ProposalSlot,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(upsertProposalRequestSchema, body);
    const ctx = actorContext(user, request);
    const item = await this.requireVisibleDefect(user, defectItemId);
    const amount = parseProposalAmount(input.amount);
    return this.prisma.client.$transaction(async (tx) => {
      await this.assertOrganizations(tx, [input.alternativeContractorOrganizationId], true);
      const current = await tx.proposal.findFirst({
        where: { defectItemId, slot, status: 'ACTIVE' },
      });
      if (current) {
        if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
          throw new StaleWriteError();
        }
        const updated = await tx.proposal.updateMany({
          where: { id: current.id, version: current.version },
          data: {
            amount,
            alternativeContractorOrganizationId: input.alternativeContractorOrganizationId,
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) {
          throw new StaleWriteError();
        }
        const fresh = await tx.proposal.findUniqueOrThrow({ where: { id: current.id } });
        await writeAuditLog(tx, {
          ...ctx,
          action: 'PROPOSAL_UPSERTED',
          entityType: 'PROPOSAL',
          entityId: fresh.id,
          parentEntityType: 'DEFECT_ITEM',
          parentEntityId: defectItemId,
          oldValue: toJsonValue({
            slot,
            amount: current.amount.toFixed(2),
            organizationId: current.alternativeContractorOrganizationId,
          }),
          newValue: toJsonValue({
            slot,
            amount,
            organizationId: input.alternativeContractorOrganizationId,
          }),
        });
        return { id: fresh.id, version: fresh.version, slot };
      }
      const created = await tx.proposal.create({
        data: {
          defectItemId,
          slot,
          amount,
          alternativeContractorOrganizationId: input.alternativeContractorOrganizationId,
          currency: 'BYN',
          status: 'ACTIVE',
        },
      });
      await writeAuditLog(tx, {
        ...ctx,
        action: 'PROPOSAL_UPSERTED',
        entityType: 'PROPOSAL',
        entityId: created.id,
        parentEntityType: 'DEFECT_ITEM',
        parentEntityId: defectItemId,
        newValue: toJsonValue({
          slot,
          amount,
          organizationId: input.alternativeContractorOrganizationId,
        }),
      });
      void item;
      return { id: created.id, version: created.version, slot };
    });
  }

  async archiveProposal(
    user: AuthenticatedUser,
    defectItemId: string,
    slot: ProposalSlot,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(archiveProposalRequestSchema, body);
    const ctx = actorContext(user, request);
    await this.requireVisibleDefect(user, defectItemId);
    const reason = normalizeRequiredReason(input.reason);
    return this.prisma.client.$transaction(async (tx) => {
      const current = await tx.proposal.findFirst({
        where: { defectItemId, slot, status: 'ACTIVE' },
      });
      if (!current) {
        throw new NotFoundException('Запись не найдена');
      }
      if (current.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const updated = await tx.proposal.updateMany({
        where: { id: current.id, version: input.expectedVersion },
        data: {
          status: 'ARCHIVED',
          archivedAt: new Date(),
          archiveReason: reason,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      await writeAuditLog(tx, {
        ...ctx,
        action: 'PROPOSAL_ARCHIVED',
        entityType: 'PROPOSAL',
        entityId: current.id,
        parentEntityType: 'DEFECT_ITEM',
        parentEntityId: defectItemId,
        reason,
        oldValue: toJsonValue({ slot, status: 'ACTIVE' }),
        newValue: toJsonValue({ slot, status: 'ARCHIVED' }),
      });
      return { id: current.id, slot, status: 'ARCHIVED' };
    });
  }

  async restoreProposal(
    user: AuthenticatedUser,
    defectItemId: string,
    slot: ProposalSlot,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(restoreProposalRequestSchema, body);
    const ctx = actorContext(user, request);
    await this.requireVisibleDefect(user, defectItemId);
    return this.prisma.client.$transaction(async (tx) => {
      const row = await tx.proposal.findFirst({
        where: { defectItemId, slot, status: 'ARCHIVED' },
        orderBy: { archivedAt: 'desc' },
      });
      if (!row || row.version !== input.expectedVersion) {
        throw row ? new StaleWriteError() : new NotFoundException('Запись не найдена');
      }
      const active = await tx.proposal.findFirst({
        where: { defectItemId, slot, status: 'ACTIVE' },
      });
      if (active) {
        throw new InvalidTransitionError('Активное предложение в этом слоте уже существует');
      }
      const updated = await tx.proposal.updateMany({
        where: { id: row.id, version: input.expectedVersion },
        data: {
          status: 'ACTIVE',
          archivedAt: null,
          archiveReason: null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      await writeAuditLog(tx, {
        ...ctx,
        action: 'PROPOSAL_RESTORED',
        entityType: 'PROPOSAL',
        entityId: row.id,
        parentEntityType: 'DEFECT_ITEM',
        parentEntityId: defectItemId,
        oldValue: toJsonValue({ slot, status: 'ARCHIVED' }),
        newValue: toJsonValue({ slot, status: 'ACTIVE' }),
      });
      return { id: row.id, slot, status: 'ACTIVE' };
    });
  }

  async actHistory(user: AuthenticatedUser, actId: string, rawQuery: Record<string, unknown>) {
    this.assertHistoryRead(user);
    if (!UUID_PATTERN.test(actId)) {
      throw new NotFoundException('Запись не найдена');
    }
    const act = await this.requireVisibleAct(user, actId);
    const assigned = await this.assignedDefectIds(user, act.id);
    return this.paginateHistory(
      user,
      {
        OR: [
          { entityType: 'ACT', entityId: act.id },
          { parentEntityType: 'ACT', parentEntityId: act.id },
          { parentEntityType: 'DEFECT_ITEM', parentEntityId: { in: [...assigned] } },
          { entityType: 'DEFECT_ITEM', entityId: { in: [...assigned] } },
        ],
      },
      assigned,
      act.id,
      rawQuery,
    );
  }

  async defectHistory(
    user: AuthenticatedUser,
    defectItemId: string,
    rawQuery: Record<string, unknown>,
  ) {
    this.assertHistoryRead(user);
    const item = await this.requireVisibleDefect(user, defectItemId);
    const assigned = await this.assignedDefectIds(user, item.actId);
    return this.paginateHistory(
      user,
      {
        OR: [
          { entityType: 'DEFECT_ITEM', entityId: item.id },
          { parentEntityType: 'DEFECT_ITEM', parentEntityId: item.id },
        ],
      },
      assigned,
      item.actId,
      rawQuery,
    );
  }

  async proposalHistory(
    user: AuthenticatedUser,
    proposalId: string,
    rawQuery: Record<string, unknown>,
  ) {
    this.assertHistoryRead(user);
    if (!UUID_PATTERN.test(proposalId)) {
      throw new NotFoundException('Запись не найдена');
    }
    const proposal = await this.prisma.client.proposal.findFirst({
      where: { id: proposalId },
      select: { id: true, slot: true, defectItemId: true },
    });
    if (!proposal) {
      throw new NotFoundException('Запись не найдена');
    }
    const item = await this.requireVisibleDefect(user, proposal.defectItemId);
    if (
      canViewAssignedHistory(user.role) &&
      !canViewFullHistory(user.role) &&
      !visibleProposalSlots(user.role).includes(proposal.slot)
    ) {
      throw new NotFoundException('Запись не найдена');
    }
    const assigned = await this.assignedDefectIds(user, item.actId);
    return this.paginateHistory(
      user,
      { entityType: 'PROPOSAL', entityId: proposal.id },
      assigned,
      item.actId,
      rawQuery,
    );
  }

  async listAuditLog(user: AuthenticatedUser, rawQuery: Record<string, unknown>) {
    this.assertHistoryRead(user);
    if (!canViewFullHistory(user.role)) {
      throw new ForbiddenException('Недостаточно прав');
    }
    return this.paginateHistory(user, {}, new Set(), '', rawQuery);
  }

  private assertHistoryRead(user: AuthenticatedUser) {
    if (!canViewHistory(user.role)) {
      throw new ForbiddenException('Недостаточно прав');
    }
  }

  private async paginateHistory(
    user: AuthenticatedUser,
    scope: Prisma.AuditLogWhereInput,
    assigned: Set<string>,
    actId: string,
    rawQuery: Record<string, unknown>,
  ) {
    const query = parseCommandBody(historyQuerySchema, rawQuery);
    const limit = query.limit ?? 50;
    const cursor = query.cursor ? decodeHistoryCursor(query.cursor) : null;
    const rows = await this.prisma.client.auditLog.findMany({
      where: {
        AND: [scope, cursor ? historyWhereAfter(cursor) : {}],
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 500,
    });
    const visible = rows
      .map((row) =>
        shapeHistoryForRole(
          {
            ...row,
            oldValue: row.oldValue,
            newValue: row.newValue,
          },
          user.role,
        ),
      )
      .filter((event) =>
        historyVisibleToRole(event, {
          role: user.role,
          assignedDefectItemIds: assigned,
          actId,
        }),
      )
      .filter((event) => (canViewAssignedHistory(user.role) ? !isProposalBcEvent(event) : true));
    const page = visible.slice(0, limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        parentEntityType: row.parentEntityType,
        parentEntityId: row.parentEntityId,
        oldValue: row.oldValue,
        newValue: row.newValue,
        reason: row.reason,
        actorUserId: row.actorUserId,
        actorName: row.actorName,
        occurredAt: row.occurredAt.toISOString(),
      })),
      nextCursor: visible.length > limit ? encodeHistoryCursor(page[page.length - 1]!) : null,
      totalCount: visible.length,
    };
  }

  private async insertDefect(
    tx: Prisma.TransactionClient,
    actId: string,
    input: {
      location: string;
      defectTypeId: string;
      workTypeId?: string | null;
      claimDetails: string;
      notes?: string | null;
      responsibleEngineerIds: string[];
      liableOrganizationIds: string[];
      plannedDeadline?: string | null;
      claimDeadline?: string | null;
      thirdPartyDeadline?: string | null;
    },
    user: AuthenticatedUser,
    outboxIds: string[],
  ): Promise<string> {
    const engineerIds = assertUniqueIds(input.responsibleEngineerIds, 'responsibleEngineerIds');
    const liableIds = assertUniqueIds(input.liableOrganizationIds, 'liableOrganizationIds');
    assertAtLeastOneEngineer(engineerIds.length);
    await this.assertDefectType(tx, input.defectTypeId);
    if (input.workTypeId) {
      await this.assertWorkType(tx, input.workTypeId);
    }
    const act = await tx.act.findUnique({ where: { id: actId }, select: { objectId: true } });
    if (!act) {
      throw new NotFoundException('Запись не найдена');
    }
    await this.assertObjectEngineers(tx, act.objectId, engineerIds);
    await this.assertEngineers(tx, engineerIds);
    await this.assertOrganizations(tx, liableIds, true);
    const created = createDefectItem({ id: randomUUID(), actId });
    await tx.defectItem.create({
      data: {
        id: created.id,
        actId,
        location: normalizeLocation(input.location),
        defectTypeId: input.defectTypeId,
        workTypeId: input.workTypeId || null,
        status: 'IN_PROGRESS',
        claimDetails: normalizeClaimDetails(input.claimDetails),
        notes: normalizeNotes(input.notes),
        plannedDeadline: input.plannedDeadline
          ? calendarDateToUtcNoon(input.plannedDeadline)
          : null,
        claimDeadline: input.claimDeadline ? calendarDateToUtcNoon(input.claimDeadline) : null,
        thirdPartyDeadline: input.thirdPartyDeadline
          ? calendarDateToUtcNoon(input.thirdPartyDeadline)
          : null,
        responsibleEngineers: {
          create: engineerIds.map((userId) => ({ userId })),
        },
        liableOrganizations: {
          create: liableIds.map((organizationId) => ({ organizationId })),
        },
      },
    });
    const fresh = await tx.defectItem.findUniqueOrThrow({ where: { id: created.id } });
    await syncSlaClocks(tx, fresh, await warningDaysOf(tx));
    outboxIds.push(
      ...(await notifyResponsibleAssigned(this.outboxWriter, tx, {
        actId,
        defectItemId: created.id,
        userIds: engineerIds,
        actorUserId: user.id,
        version: 1,
      })),
    );
    return created.id;
  }

  private async assertCreatableObject(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    objectId: string,
  ) {
    if (!isObjectScopedRole(user.role)) {
      return;
    }
    const object = await tx.propertyObject.findFirst({
      where: {
        ...new RegistryAccessScope(user).objectVisibleWhere(objectId),
        active: true,
      },
      select: { id: true },
    });
    if (!object) {
      throw new NotFoundException('Запись не найдена');
    }
  }

  private async assertObjectEngineers(
    tx: Prisma.TransactionClient,
    objectId: string,
    ids: string[],
  ) {
    if (ids.length === 0) {
      return;
    }
    const assigned = await tx.propertyObjectEngineer.findMany({
      where: { propertyObjectId: objectId, userId: { in: ids }, unassignedAt: null },
      select: { userId: true },
    });
    if (assigned.length !== ids.length) {
      throw new ValidationError(
        'responsibleEngineerIds',
        'Назначить можно только инженера, закреплённого за объектом',
      );
    }
  }

  private async requireVisibleActOn(
    client: Prisma.TransactionClient,
    user: AuthenticatedUser,
    actId: string,
  ) {
    if (!UUID_PATTERN.test(actId)) {
      throw new NotFoundException('Запись не найдена');
    }
    const act = await client.act.findFirst({
      where: new RegistryAccessScope(user).actVisibleWhere(actId),
    });
    if (!act) {
      throw new NotFoundException('Запись не найдена');
    }
    return act;
  }

  private async requireVisibleDefectOn(
    client: Prisma.TransactionClient,
    user: AuthenticatedUser,
    defectItemId: string,
  ) {
    if (!UUID_PATTERN.test(defectItemId)) {
      throw new NotFoundException('Запись не найдена');
    }
    const item = await client.defectItem.findFirst({
      where: { id: defectItemId, AND: [new RegistryAccessScope(user).defectItemWhere()] },
      include: { act: { select: { objectId: true } } },
    });
    if (!item) {
      throw new NotFoundException('Запись не найдена');
    }
    return item;
  }

  private async assertActHeaderRefs(
    tx: Prisma.TransactionClient,
    objectId: string,
    customerOrganizationId: string,
  ) {
    const object = await tx.propertyObject.findUnique({ where: { id: objectId } });
    if (!object?.active) {
      throw new ValidationError('objectId', 'Можно выбрать только активный объект');
    }
    const customer = await tx.organization.findUnique({
      where: { id: customerOrganizationId },
      include: { roles: true },
    });
    if (!customer?.active || !customer.roles.some((role) => role.role === 'CUSTOMER')) {
      throw new ValidationError(
        'customerOrganizationId',
        'Можно выбрать только активного заказчика',
      );
    }
  }

  private async assertDefectType(tx: Prisma.TransactionClient, defectTypeId: string) {
    const type = await tx.defectType.findUnique({ where: { id: defectTypeId } });
    if (!type?.active) {
      throw new ValidationError('defectTypeId', 'Можно выбрать только активный вид дефекта');
    }
  }

  private async assertWorkType(tx: Prisma.TransactionClient, workTypeId: string) {
    const type = await tx.workType.findUnique({ where: { id: workTypeId } });
    if (!type?.active) {
      throw new ValidationError('workTypeId', 'Можно выбрать только активный вид работ');
    }
  }

  private async assertEngineers(tx: Prisma.TransactionClient, ids: string[]) {
    if (ids.length === 0) {
      return;
    }
    const users = await tx.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, role: true, status: true },
    });
    if (users.length !== ids.length) {
      throw new ValidationError('responsibleEngineerIds', 'Инженер не найден');
    }
    if (users.some((row) => row.status !== 'ACTIVE' || row.role !== ASSIGNABLE_ENGINEER_ROLE)) {
      throw new ValidationError(
        'responsibleEngineerIds',
        'Назначить можно только активного ответственного инженера',
      );
    }
  }

  private async assertOrganizations(
    tx: Prisma.TransactionClient,
    ids: string[],
    requireActive: boolean,
  ) {
    if (ids.length === 0) {
      return;
    }
    const rows = await tx.organization.findMany({ where: { id: { in: ids } } });
    if (rows.length !== ids.length) {
      throw new ValidationError('liableOrganizationIds', 'Организация не найдена');
    }
    if (requireActive && rows.some((row) => !row.active)) {
      throw new ValidationError('liableOrganizationIds', 'Нельзя назначить архивную организацию');
    }
  }

  private async requireVisibleAct(user: AuthenticatedUser, actId: string) {
    if (!UUID_PATTERN.test(actId)) {
      throw new NotFoundException('Запись не найдена');
    }
    const scope = new RegistryAccessScope(user);
    const act = await this.prisma.client.act.findFirst({
      where: scope.actVisibleWhere(actId),
      select: { id: true, status: true, startedAt: true },
    });
    if (!act) {
      throw new NotFoundException('Запись не найдена');
    }
    return act;
  }

  private async requireVisibleDefect(user: AuthenticatedUser, defectItemId: string) {
    if (!UUID_PATTERN.test(defectItemId)) {
      throw new NotFoundException('Запись не найдена');
    }
    const scope = new RegistryAccessScope(user);
    const item = await this.prisma.client.defectItem.findFirst({
      where: { id: defectItemId, AND: [scope.defectItemWhere()] },
    });
    if (!item) {
      throw new NotFoundException('Запись не найдена');
    }
    return item;
  }

  private async assignedDefectIds(user: AuthenticatedUser, actId: string): Promise<Set<string>> {
    const scope = new RegistryAccessScope(user);
    const items = await this.prisma.client.defectItem.findMany({
      where: scope.defectItemsOnActWhere(actId),
      select: { id: true },
    });
    return new Set(items.map((item) => item.id));
  }

  private async syncActStatus(tx: Prisma.TransactionClient, actId: string) {
    const act = await tx.act.findUniqueOrThrow({ where: { id: actId } });
    if (act.status === 'CANCELLED') {
      return;
    }
    const items = await tx.defectItem.findMany({ where: { actId } });
    await tx.act.update({
      where: { id: actId },
      data: {
        status: computeActStatus(
          items.map((item) => ({ status: item.status, active: true })),
          { startedAt: act.startedAt, cancelledAt: act.cancelledAt },
        ),
      },
    });
  }
}

function prismaRawMessage(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
  }
  if (error && typeof error === 'object' && 'meta' in error) {
    const meta = (error as { meta?: { message?: unknown; cause?: unknown } }).meta;
    if (typeof meta?.message === 'string') {
      parts.push(meta.message);
    }
    if (typeof meta?.cause === 'string') {
      parts.push(meta.cause);
    }
  }
  return parts.join('\n');
}

function rethrowIfActNotStarted(error: unknown): void {
  if (prismaRawMessage(error).includes('Нельзя исполнить дефект до начала работы по акту')) {
    throw new InvalidTransitionError('Нельзя исполнить дефект до начала работы по акту');
  }
}

function mapStartActError(error: unknown): never {
  if (
    error instanceof NotFoundException ||
    error instanceof ForbiddenException ||
    error instanceof InvalidTransitionError ||
    error instanceof StaleWriteError
  ) {
    throw error;
  }
  const message = prismaRawMessage(error);
  if (message.includes('Запись не найдена')) {
    throw new NotFoundException('Запись не найдена');
  }
  if (message.includes('Недостаточно прав')) {
    throw new ForbiddenException('Недостаточно прав');
  }
  throw error;
}
