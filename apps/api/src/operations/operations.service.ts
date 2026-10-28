import { randomUUID } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  acceptDefectRepairRequestSchema,
  addDefectRequestSchema,
  archiveProposalRequestSchema,
  auditLogQuerySchema,
  completeDefectRequestSchema,
  cancelActRequestSchema,
  createActRequestSchema,
  historyQuerySchema,
  patchActHeaderRequestSchema,
  patchDeadlinesRequestSchema,
  rejectDefectRepairRequestSchema,
  reopenDefectRequestSchema,
  replaceAssignmentsRequestSchema,
  submitDefectForInspectionRequestSchema,
  restoreProposalRequestSchema,
  startActRequestSchema,
  upsertProposalRequestSchema,
  type ProposalSlot,
} from '@sgr-registry/contracts';
import { allocateActNumber, Prisma, startActViaDefiner } from '@sgr-registry/database';
import { openInspectionAttempt, settleInspectionAttempt } from './inspection-attempts.js';
import { loadActorNamePartsByUserId } from '../common/actor-name-parts.js';
import {
  ASSIGNABLE_ENGINEER_ROLE,
  BUSINESS_TIME_ZONE,
  IdempotencyConflictError,
  ActNumberImmutableError,
  ActCancellationError,
  InvalidTransitionError,
  StaleWriteError,
  ValidationError,
  assertAtLeastOneEngineer,
  assertDeadlineFieldAllowed,
  assertUniqueIds,
  draftStartGaps,
  isBlankDraftDefect,
  normalizeDraftClaimDetails,
  normalizeDraftLocation,
  normalizeDraftNotes,
  parseOptionalCalendarDate,
  singleResponsibleEngineerId,
  actStatusLabel,
  calendarDateInTimeZone,
  calendarDateToUtcNoon,
  resolveCompletionInstant,
  assertInstantNotBefore,
  canViewAssignedHistory,
  canViewFullHistory,
  canViewHistory,
  canCreatePropertyObject,
  canCreateWorkSupplier,
  canManageReferenceData,
  canManageUsers,
  acceptDefectRepair,
  assertDirectCompletionAllowed,
  cancelAct,
  completeDefectItem,
  rejectDefectRepair,
  submitDefectForInspection,
  computeActStatus,
  createDefectItem,
  deadlineChangeRequiresReason,
  deadlineFieldsForRole,
  historyVisibleToRole,
  isObjectScopedRole,
  isOversightRole,
  isProposalBcEvent,
  normalizeLocation,
  normalizeNotes,
  normalizeRequiredReason,
  parseOptionalDeadline,
  parseProposalAmount,
  reopenDefectItem,
  shapeHistoryForRole,
  scrubSensitiveValue,
  visibleProposalSlots,
  isBusinessStaffRole,
} from '@sgr-registry/domain';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { PrismaService } from '../auth/prisma.tokens.js';
import { toJsonValue, writeAuditLog } from '../common/audit-writer.js';
import { isPrismaUniqueConflict, parseCommandBody } from '../common/command-body.js';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyWhereAfter,
} from '../common/history-cursor.js';
import {
  actorContext,
  canonicalRequestHash,
  readIdempotencyKey,
} from '../common/request-context.js';
import { resolveRegistryAccessScope } from '../registry/registry-access-scope.js';
import {
  notifyActCancelled,
  notifyContractorsAssigned,
  notifyDeadlineActivated,
  notifyDeadlineChanges,
  notifyDefectRepairRejected,
  notifyDefectStatus,
  notifyDefectSubmittedForInspection,
  notifyIncompleteWorkSupplier,
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

  async lookups(user: AuthenticatedUser, selectedObjectId?: string | null) {
    const scope = await resolveRegistryAccessScope(this.prisma.client, user);
    const includeInactive = isOversightRole(user.role);
    const objectWhere: Prisma.PropertyObjectWhereInput = {
      ...(includeInactive ? {} : { active: true }),
      ...(scope.objectScoped ? { engineers: { some: scope.assignedObjectRelationWhere() } } : {}),
      ...(scope.organizationScoped
        ? {
            acts: {
              some: {
                status: { not: 'CANCELLED' as const },
                defectItems: { some: scope.liableDefectWhere() },
              },
            },
          }
        : {}),
    };
    const [objects, customers, liable, alternatives, defectTypes, workTypes, engineers] =
      await Promise.all([
        this.prisma.client.propertyObject.findMany({
          where: objectWhere,
          select: {
            id: true,
            name: true,
            address: true,
            active: true,
            engineers: {
              where: { unassignedAt: null },
              select: { userId: true },
            },
          },
          orderBy: [{ nameSortKey: 'asc' }, { id: 'asc' }],
        }),
        this.prisma.client.organization.findMany({
          where: {
            ...(includeInactive ? {} : { active: true }),
            roles: { some: { role: 'CUSTOMER' } },
          },
          select: { id: true, officialName: true },
          orderBy: { officialName: 'asc' },
        }),
        this.prisma.client.organization.findMany({
          where: {
            ...(includeInactive ? {} : { active: true }),
            roles: { some: { role: 'LIABLE_CONTRACTOR' } },
          },
          select: { id: true, officialName: true },
          orderBy: { officialName: 'asc' },
        }),
        this.prisma.client.organization.findMany({
          where: {
            ...(includeInactive ? {} : { active: true }),
            roles: { some: { role: 'ALTERNATIVE_CONTRACTOR' } },
          },
          select: { id: true, officialName: true },
          orderBy: { officialName: 'asc' },
        }),
        this.prisma.client.defectType.findMany({
          where: includeInactive ? {} : { active: true },
          select: { id: true, name: true, code: true },
          orderBy: [{ nameSortKey: 'asc' }, { id: 'asc' }],
        }),
        this.prisma.client.workType.findMany({
          where: includeInactive ? {} : { active: true },
          select: { id: true, name: true, code: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        this.prisma.client.user.findMany({
          where: {
            role: ASSIGNABLE_ENGINEER_ROLE,
            ...(includeInactive ? {} : { status: 'ACTIVE' }),
          },
          select: { id: true, lastName: true, firstName: true, middleName: true, fullName: true },
          orderBy: { fullName: 'asc' },
        }),
      ]);
    const selectedObject = selectedObjectId
      ? objects.find((object) => object.id === selectedObjectId)
      : undefined;
    const assignedToSelected = new Set(selectedObject?.engineers.map((row) => row.userId) ?? []);
    const rankedEngineers = [...engineers].sort((left, right) => {
      const leftAssigned = assignedToSelected.has(left.id) ? 0 : 1;
      const rightAssigned = assignedToSelected.has(right.id) ? 0 : 1;
      if (leftAssigned !== rightAssigned) {
        return leftAssigned - rightAssigned;
      }
      return left.fullName.localeCompare(right.fullName, 'ru');
    });
    return {
      propertyObjects: objects.map((object) => ({
        id: object.id,
        name: object.name,
        address: object.address ?? '',
        active: object.active,
        responsibleEngineerIds: object.engineers.map((row) => row.userId),
      })),
      customers,
      liableOrganizations: liable,
      alternativeContractors: alternatives,
      defectTypes,
      workTypes,
      responsibleEngineers: rankedEngineers.map((engineer) => ({
        id: engineer.id,
        lastName: engineer.lastName,
        firstName: engineer.firstName,
        middleName: engineer.middleName,
        fullName: engineer.fullName,
        assignedToSelectedObject: assignedToSelected.has(engineer.id),
      })),
      canViewLookups: true,
      actorRole: user.role,
      canCreate: {
        propertyObject: canCreatePropertyObject(user.role),
        organization: canManageReferenceData(user.role),
        workSupplier: canCreateWorkSupplier(user.role),
        workType: canManageReferenceData(user.role),
        defectType: canManageReferenceData(user.role),
        responsibleEngineer: canManageUsers(user.role),
      },
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
    const ctx = actorContext(user, request);
    const issuedOn = input.issuedOn ? parseOptionalCalendarDate(input.issuedOn, 'issuedOn') : null;
    const issuedAt = issuedOn ? calendarDateToUtcNoon(issuedOn) : null;
    const defectItems = this.normalizeDraftDefects(input.defectItems ?? []);
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
        await this.assertDraftHeader(tx, user, {
          objectId: input.objectId ?? null,
          customerOrganizationId: input.customerOrganizationId ?? null,
          fillingEngineerId: input.fillingEngineerId ?? null,
        });
        const number =
          input.formCode && issuedAt ? await allocateActNumber(tx, input.formCode, issuedAt) : null;
        const act = await tx.act.create({
          data: {
            officialNumber: number?.officialNumber ?? null,
            formCode: number?.formCode ?? input.formCode ?? null,
            year: number?.year ?? null,
            sequence: number?.sequence ?? null,
            objectId: input.objectId ?? null,
            customerOrganizationId: input.customerOrganizationId ?? null,
            issuedOn: issuedAt,
            createdById: user.id,
            fillingEngineerId: input.fillingEngineerId ?? null,
            status: 'NEW',
          },
        });
        const defectIds: string[] = [];
        for (const item of defectItems) {
          const defectId = await this.insertDefect(tx, act.id, item, user, outboxIds, true);
          defectIds.push(defectId);
        }
        const payload = {
          id: act.id,
          officialNumber: act.officialNumber,
          version: act.version,
          updatedAt: act.updatedAt.toISOString(),
        };
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
            fillingEngineerId: act.fillingEngineerId,
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
      const nextObjectId = input.objectId === undefined ? current.objectId : input.objectId;
      const nextCustomerId =
        input.customerOrganizationId === undefined
          ? current.customerOrganizationId
          : input.customerOrganizationId;
      const nextFormCode = input.formCode === undefined ? current.formCode : input.formCode;
      const parsedIssuedOn =
        input.issuedOn === undefined || input.issuedOn === null
          ? null
          : parseOptionalCalendarDate(input.issuedOn, 'issuedOn');
      const nextIssuedOn =
        input.issuedOn === undefined
          ? current.issuedOn
          : parsedIssuedOn
            ? calendarDateToUtcNoon(parsedIssuedOn)
            : null;
      const nextFillingEngineerId =
        input.fillingEngineerId === undefined ? current.fillingEngineerId : input.fillingEngineerId;
      if (
        current.status !== 'NEW' &&
        (!nextObjectId || !nextCustomerId || !nextIssuedOn || !nextFormCode)
      ) {
        throw new ValidationError('act', 'После начала работы эти поля нельзя очистить');
      }
      await this.assertDraftHeader(tx, user, {
        objectId: nextObjectId,
        customerOrganizationId: nextCustomerId,
        fillingEngineerId: nextFillingEngineerId,
      });
      const identityLocked = actFormIdentityLocked(current);
      if (identityLocked && input.formCode !== undefined && input.formCode !== current.formCode) {
        throw new ActNumberImmutableError();
      }
      const issuedUnchanged =
        (current.issuedOn == null && nextIssuedOn == null) ||
        (current.issuedOn != null &&
          nextIssuedOn != null &&
          current.issuedOn.getTime() === nextIssuedOn.getTime());
      if (
        nextObjectId === current.objectId &&
        nextCustomerId === current.customerOrganizationId &&
        nextFillingEngineerId === current.fillingEngineerId &&
        issuedUnchanged
      ) {
        return { id: current.id, version: current.version };
      }
      if (!identityLocked && !current.officialNumber && nextFormCode && nextIssuedOn) {
        const number = await allocateActNumber(tx, nextFormCode, nextIssuedOn);
        await tx.act.update({
          where: { id: actId },
          data: {
            officialNumber: number.officialNumber,
            formCode: number.formCode,
            year: number.year,
            sequence: number.sequence,
          },
        });
      }
      const updated = await tx.act.updateMany({
        where: { id: actId, version: input.expectedVersion },
        data: {
          objectId: nextObjectId,
          customerOrganizationId: nextCustomerId,
          ...(identityLocked
            ? {}
            : { formCode: current.officialNumber ? current.formCode : nextFormCode }),
          issuedOn: nextIssuedOn,
          fillingEngineerId: nextFillingEngineerId,
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
          issuedOn: current.issuedOn ? calendarDateInTimeZone(current.issuedOn) : null,
          fillingEngineerId: current.fillingEngineerId,
        }),
        newValue: toJsonValue({
          objectId: fresh.objectId,
          customerOrganizationId: fresh.customerOrganizationId,
          issuedOn: fresh.issuedOn ? calendarDateInTimeZone(fresh.issuedOn) : null,
          fillingEngineerId: fresh.fillingEngineerId,
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
      if (isBlankDraftDefect(input)) {
        throw new ValidationError('defectItems', 'Заполните хотя бы одно поле дефекта');
      }
      const defectId = await this.insertDefect(
        tx,
        actId,
        input,
        user,
        outboxIds,
        act.status === 'NEW',
      );
      const items = await tx.defectItem.findMany({ where: { actId } });
      await tx.act.update({
        where: { id: actId },
        data: {
          status: computeActStatus(
            items.map((row) => ({ status: row.status, active: true })),
            { startedAt: act.startedAt, cancelledAt: act.cancelledAt },
            { currentStatus: act.status },
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
    const engineerId = singleResponsibleEngineerId(
      input.responsibleEngineerIds,
      input.responsibleEngineerId,
    );
    const engineerIds = engineerId ? [engineerId] : [];
    const liableIds = assertUniqueIds(input.liableOrganizationIds, 'liableOrganizationIds');
    const parentAct = await this.requireVisibleAct(user, item.actId);
    if (
      parentAct.status !== 'NEW' &&
      engineerIds.length === 0 &&
      !input.confirmRemoveLastEngineer
    ) {
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
        const previousLiableIds = previousLiable.map((row) => row.organizationId);
        const addedLiable = liableIds.filter((id) => !previousLiableIds.includes(id));
        const outboxIds =
          parentAct.status === 'NEW'
            ? []
            : [
                ...(await notifyResponsibleAssigned(this.outboxWriter, tx, {
                  actId: item.actId,
                  defectItemId,
                  userIds: added,
                  actorUserId: user.id,
                  version: item.version + 1,
                })),
                ...(await notifyContractorsAssigned(this.outboxWriter, tx, {
                  actId: item.actId,
                  defectItemId,
                  organizationIds: addedLiable,
                  actorUserId: user.id,
                  version: item.version + 1,
                })),
              ];
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
    const deadlineAct = await this.requireVisibleAct(user, item.actId);
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
      const outboxIds =
        deadlineAct.status === 'NEW'
          ? []
          : await notifyDeadlineChanges(this.outboxWriter, tx, {
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
    const liableCount = await this.prisma.client.defectItemLiableOrganization.count({
      where: { defectItemId },
    });
    assertDirectCompletionAllowed(liableCount > 0);
    const requestedReadyAt = input.readyAt
      ? calendarDateToUtcNoon(input.readyAt)
      : calendarDateToUtcNoon(calendarDateInTimeZone(new Date(), BUSINESS_TIME_ZONE));
    const readyAt = resolveCompletionInstant(requestedReadyAt, item.createdAt);
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

  async submitForInspection(
    user: AuthenticatedUser,
    defectItemId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(submitDefectForInspectionRequestSchema, body);
    const comment = normalizeRequiredReason(input.comment);
    const ctx = actorContext(user, request);
    const item = await this.requireVisibleDefect(user, defectItemId);
    const act = await this.requireVisibleAct(user, item.actId);
    if (act.status === 'NEW' || act.startedAt == null) {
      throw new InvalidTransitionError(
        'Нельзя передать дефект на проверку до начала работы по акту',
      );
    }
    const liableCount = await this.prisma.client.defectItemLiableOrganization.count({
      where: { defectItemId },
    });
    if (liableCount === 0) {
      throw new InvalidTransitionError(
        'Передача на проверку доступна только для подрядного дефекта',
      );
    }
    if (item.status === 'PENDING_INSPECTION') {
      return { id: item.id, version: item.version, status: item.status };
    }
    submitDefectForInspection(
      { id: item.id, actId: item.actId, status: item.status, readyAt: item.readyAt },
      { comment },
    );
    const submittedAt = new Date();
    assertInstantNotBefore(submittedAt, item.createdAt);
    const result = await this.prisma.client.$transaction(async (tx) => {
      if (item.version !== input.expectedVersion) {
        const latest = await tx.defectItem.findUnique({ where: { id: defectItemId } });
        if (latest?.status === 'PENDING_INSPECTION') {
          return {
            id: latest.id,
            version: latest.version,
            status: latest.status,
            outboxIds: [] as string[],
          };
        }
        throw new StaleWriteError();
      }
      const updated = await tx.defectItem.updateMany({
        where: { id: defectItemId, version: input.expectedVersion, status: 'IN_PROGRESS' },
        data: {
          status: 'PENDING_INSPECTION',
          submittedForInspectionAt: submittedAt,
          submittedByUserId: user.id,
          submissionComment: comment,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        const latest = await tx.defectItem.findUnique({ where: { id: defectItemId } });
        if (latest?.status === 'PENDING_INSPECTION') {
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
      const outboxIds = await notifyDefectSubmittedForInspection(this.outboxWriter, tx, {
        actId: item.actId,
        defectItemId,
        actorUserId: user.id,
        version: fresh.version,
        defect: {
          id: fresh.id,
          status: fresh.status,
          claimDeadline: fresh.claimDeadline,
          plannedDeadline: fresh.plannedDeadline,
          thirdPartyDeadline: fresh.thirdPartyDeadline,
        },
      });
      await openInspectionAttempt(tx, {
        defectItemId,
        userId: user.id,
        submittedAt: fresh.submittedForInspectionAt ?? submittedAt,
        comment,
      });
      await writeAuditLog(tx, {
        ...ctx,
        action: 'DEFECT_SUBMITTED_FOR_INSPECTION',
        entityType: 'DEFECT_ITEM',
        entityId: defectItemId,
        parentEntityType: 'ACT',
        parentEntityId: item.actId,
        oldValue: toJsonValue({ status: 'IN_PROGRESS' }),
        newValue: toJsonValue({ status: 'PENDING_INSPECTION', comment }),
      });
      return { id: fresh.id, version: fresh.version, status: fresh.status, outboxIds };
    });
    await this.outboxWriter.enqueue(result.outboxIds);
    return { id: result.id, version: result.version, status: result.status };
  }

  async acceptRepair(
    user: AuthenticatedUser,
    defectItemId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(acceptDefectRepairRequestSchema, body);
    const ctx = actorContext(user, request);
    const item = await this.requireVisibleDefect(user, defectItemId);
    const act = await this.requireVisibleAct(user, item.actId);
    if (act.status === 'NEW' || act.startedAt == null) {
      throw new InvalidTransitionError('Нельзя принять устранение до начала работы по акту');
    }
    if (item.status === 'COMPLETED') {
      return { id: item.id, version: item.version, status: item.status };
    }
    const liableCount = await this.prisma.client.defectItemLiableOrganization.count({
      where: { defectItemId },
    });
    if (liableCount === 0) {
      throw new InvalidTransitionError('Приёмка устранения доступна только для подрядного дефекта');
    }
    acceptDefectRepair({
      id: item.id,
      actId: item.actId,
      status: item.status,
      readyAt: item.readyAt,
    });
    const acceptedAt = new Date();
    if (item.submittedForInspectionAt) {
      assertInstantNotBefore(acceptedAt, item.submittedForInspectionAt);
    }
    assertInstantNotBefore(acceptedAt, item.createdAt);
    const readyAt = resolveCompletionInstant(
      calendarDateToUtcNoon(calendarDateInTimeZone(acceptedAt, BUSINESS_TIME_ZONE)),
      item.createdAt,
      acceptedAt,
    );
    const result = await this.prisma.client.$transaction(async (tx) => {
      if (item.version !== input.expectedVersion) {
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
      const updated = await tx.defectItem.updateMany({
        where: { id: defectItemId, version: input.expectedVersion, status: 'PENDING_INSPECTION' },
        data: {
          status: 'COMPLETED',
          readyAt,
          acceptedAt,
          acceptedByUserId: user.id,
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
      await settleInspectionAttempt(tx, {
        defectItemId,
        status: 'ACCEPTED',
        userId: user.id,
        reviewedAt: acceptedAt,
      });
      await this.syncActStatus(tx, item.actId);
      const fresh = await tx.defectItem.findUniqueOrThrow({ where: { id: defectItemId } });
      const outboxIds = await notifyDefectStatus(this.outboxWriter, tx, {
        type: 'DEFECT_COMPLETED',
        actId: item.actId,
        defectItemId,
        actorUserId: user.id,
        occurrenceToken: fresh.version,
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
        oldValue: toJsonValue({ status: 'PENDING_INSPECTION' }),
        newValue: toJsonValue({ status: 'COMPLETED', acceptedByUserId: user.id }),
      });
      return { id: fresh.id, version: fresh.version, status: fresh.status, outboxIds };
    });
    await this.outboxWriter.enqueue(result.outboxIds);
    return { id: result.id, version: result.version, status: result.status };
  }

  async rejectRepair(
    user: AuthenticatedUser,
    defectItemId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    const input = parseCommandBody(rejectDefectRepairRequestSchema, body);
    const reason = normalizeRequiredReason(input.reason);
    const ctx = actorContext(user, request);
    const item = await this.requireVisibleDefect(user, defectItemId);
    const liableCount = await this.prisma.client.defectItemLiableOrganization.count({
      where: { defectItemId },
    });
    if (liableCount === 0) {
      throw new InvalidTransitionError(
        'Возврат на доработку доступен только для подрядного дефекта',
      );
    }
    rejectDefectRepair(
      { id: item.id, actId: item.actId, status: item.status, readyAt: item.readyAt },
      { reason },
    );
    const rejectedAt = new Date();
    if (item.submittedForInspectionAt) {
      assertInstantNotBefore(rejectedAt, item.submittedForInspectionAt);
    }
    assertInstantNotBefore(rejectedAt, item.createdAt);
    const result = await this.prisma.client.$transaction(async (tx) => {
      if (item.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const updated = await tx.defectItem.updateMany({
        where: { id: defectItemId, version: input.expectedVersion, status: 'PENDING_INSPECTION' },
        data: {
          status: 'IN_PROGRESS',
          rejectedAt,
          rejectedByUserId: user.id,
          rejectionReason: reason,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StaleWriteError();
      }
      await settleInspectionAttempt(tx, {
        defectItemId,
        status: 'REJECTED',
        userId: user.id,
        reviewedAt: rejectedAt,
        rejectionReason: reason,
      });
      await this.syncActStatus(tx, item.actId);
      const fresh = await tx.defectItem.findUniqueOrThrow({ where: { id: defectItemId } });
      const outboxIds = await notifyDefectRepairRejected(this.outboxWriter, tx, {
        actId: item.actId,
        defectItemId,
        actorUserId: user.id,
        version: fresh.version,
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
        action: 'DEFECT_REPAIR_REJECTED',
        entityType: 'DEFECT_ITEM',
        entityId: defectItemId,
        parentEntityType: 'ACT',
        parentEntityId: item.actId,
        reason,
        oldValue: toJsonValue({ status: 'PENDING_INSPECTION' }),
        newValue: toJsonValue({ status: 'IN_PROGRESS', reason }),
      });
      return { id: fresh.id, version: fresh.version, status: fresh.status, outboxIds };
    });
    await this.outboxWriter.enqueue(result.outboxIds);
    return { id: result.id, version: result.version, status: result.status };
  }

  async cancel(user: AuthenticatedUser, actId: string, body: unknown, request: FastifyRequest) {
    const input = parseCommandBody(cancelActRequestSchema, body);
    const reason = normalizeRequiredReason(input.reason);
    const ctx = actorContext(user, request);
    const visible = await this.requireVisibleAct(user, actId);
    if (visible.status === 'COMPLETED') {
      throw new ActCancellationError('Завершённый акт нельзя аннулировать');
    }
    if (visible.status === 'CANCELLED') {
      const current = await this.prisma.client.act.findUniqueOrThrow({
        where: { id: actId },
        select: {
          id: true,
          status: true,
          version: true,
          cancellationReason: true,
          cancelledAt: true,
        },
      });
      return {
        id: current.id,
        status: current.status,
        version: current.version,
        cancellationReason: current.cancellationReason,
        cancelledAt: current.cancelledAt?.toISOString() ?? null,
      };
    }
    const result = await this.prisma.client.$transaction(async (tx) => {
      const current = await tx.act.findUniqueOrThrow({ where: { id: actId } });
      if (current.status === 'CANCELLED') {
        return {
          id: current.id,
          status: current.status,
          version: current.version,
          cancellationReason: current.cancellationReason,
          cancelledAt: current.cancelledAt?.toISOString() ?? null,
          outboxIds: [] as string[],
        };
      }
      cancelAct(
        { status: current.status, cancelledAt: current.cancelledAt },
        { reason, cancelledByUserId: user.id },
      );
      if (current.version !== input.expectedVersion) {
        throw new StaleWriteError();
      }
      const updated = await tx.act.updateMany({
        where: {
          id: actId,
          version: input.expectedVersion,
          status: { notIn: ['CANCELLED', 'COMPLETED'] },
        },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: reason,
          cancelledByUserId: user.id,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        const latest = await tx.act.findUniqueOrThrow({ where: { id: actId } });
        if (latest.status === 'CANCELLED') {
          return {
            id: latest.id,
            status: latest.status,
            version: latest.version,
            cancellationReason: latest.cancellationReason,
            cancelledAt: latest.cancelledAt?.toISOString() ?? null,
            outboxIds: [] as string[],
          };
        }
        throw new StaleWriteError();
      }
      const fresh = await tx.act.findUniqueOrThrow({ where: { id: actId } });
      const outboxId = await notifyActCancelled(this.outboxWriter, tx, {
        actId,
        objectId: fresh.objectId,
        actorUserId: user.id,
      });
      await writeAuditLog(tx, {
        ...ctx,
        action: 'ACT_CANCELLED',
        entityType: 'ACT',
        entityId: actId,
        reason,
        oldValue: toJsonValue({ status: current.status }),
        newValue: toJsonValue({
          status: 'CANCELLED',
          cancellationReason: reason,
          cancelledByUserId: user.id,
        }),
      });
      return {
        id: fresh.id,
        status: fresh.status,
        version: fresh.version,
        cancellationReason: fresh.cancellationReason,
        cancelledAt: fresh.cancelledAt?.toISOString() ?? null,
        outboxIds: [outboxId],
      };
    });
    await this.outboxWriter.enqueue(result.outboxIds);
    return {
      id: result.id,
      status: result.status,
      version: result.version,
      cancellationReason: result.cancellationReason,
      cancelledAt: result.cancelledAt,
    };
  }

  async startAct(user: AuthenticatedUser, actId: string, body: unknown, request: FastifyRequest) {
    parseCommandBody(startActRequestSchema, body);
    const ctx = actorContext(user, request);
    const current = await this.requireVisibleAct(user, actId);
    const defects = await this.prisma.client.defectItem.findMany({
      where: { actId },
      select: {
        id: true,
        defectTypeId: true,
        status: true,
        claimDeadline: true,
        plannedDeadline: true,
        thirdPartyDeadline: true,
      },
    });
    const gaps = draftStartGaps({
      objectId: current.objectId,
      customerOrganizationId: current.customerOrganizationId,
      issuedOn: current.issuedOn,
      formCode: current.formCode,
      defects,
    });
    if (gaps.length > 0) {
      throw new ValidationError('act', `Чтобы взять акт в работу, заполните: ${gaps.join(', ')}`);
    }
    try {
      const outcome = await this.prisma.client.$transaction(async (tx) => {
        if (
          !actFormIdentityLocked(current) &&
          !current.officialNumber &&
          current.formCode &&
          current.issuedOn
        ) {
          const number = await allocateActNumber(tx, current.formCode, current.issuedOn);
          await tx.act.update({
            where: { id: actId },
            data: {
              officialNumber: number.officialNumber,
              formCode: number.formCode,
              year: number.year,
              sequence: number.sequence,
            },
          });
        }
        const started = await startActViaDefiner(tx, {
          actId,
          requestId: ctx.requestId,
        });
        const warningDays = await warningDaysOf(tx);
        const outboxIds: string[] = [];
        for (const defect of defects) {
          await syncSlaClocks(tx, defect, warningDays);
          if (!started.alreadyStarted) {
            outboxIds.push(
              ...(await notifyDeadlineActivated(this.outboxWriter, tx, {
                actId,
                defectItemId: defect.id,
                actorUserId: user.id,
                claimDeadline: defect.claimDeadline,
                plannedDeadline: defect.plannedDeadline,
              })),
            );
          }
        }
        if (!started.alreadyStarted) {
          const assigned = await tx.defectItem.findMany({
            where: { actId },
            select: {
              id: true,
              version: true,
              responsibleEngineers: { select: { userId: true } },
              liableOrganizations: { select: { organizationId: true } },
            },
          });
          for (const defect of assigned) {
            outboxIds.push(
              ...(await notifyResponsibleAssigned(this.outboxWriter, tx, {
                actId,
                defectItemId: defect.id,
                userIds: defect.responsibleEngineers.map((row) => row.userId),
                actorUserId: user.id,
                version: defect.version,
              })),
              ...(await notifyContractorsAssigned(this.outboxWriter, tx, {
                actId,
                defectItemId: defect.id,
                organizationIds: defect.liableOrganizations.map((row) => row.organizationId),
                actorUserId: user.id,
                version: defect.version,
              })),
            );
          }
        }
        return {
          outboxIds,
          body: {
            id: started.id,
            status: started.status,
            statusLabel: actStatusLabel(started.status),
            version: started.version,
            startedAt: started.startedAt ? started.startedAt.toISOString() : null,
            startedBy:
              started.startedById && started.startedByName
                ? { id: started.startedById, fullName: started.startedByName }
                : null,
          },
        };
      });
      await this.outboxWriter.enqueue(outcome.outboxIds);
      return outcome.body;
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
    const result = await this.prisma.client.$transaction(async (tx) => {
      await this.assertOrganizations(tx, [input.alternativeContractorOrganizationId], true);
      const supplierNoticeIds = await notifyIncompleteWorkSupplier(this.outboxWriter, tx, {
        organizationId: input.alternativeContractorOrganizationId,
        actorUserId: user.id,
      });
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
        return { id: fresh.id, version: fresh.version, slot, outboxIds: supplierNoticeIds };
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
      return { id: created.id, version: created.version, slot, outboxIds: supplierNoticeIds };
    });
    await this.outboxWriter.enqueue(result.outboxIds);
    return { id: result.id, version: result.version, slot: result.slot };
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
    const query = parseCommandBody(auditLogQuerySchema, rawQuery);
    const pageSize = query.pageSize ?? query.limit ?? 50;
    const page = query.page ?? 1;
    const search = query.search?.trim() ?? '';
    const filters: Prisma.AuditLogWhereInput[] = [];
    if (query.actorUserId) {
      filters.push({ actorUserId: query.actorUserId });
    }
    if (query.action) {
      filters.push({ action: query.action });
    }
    if (query.entityType) {
      filters.push({ entityType: query.entityType });
    }
    if (query.entityId) {
      filters.push({ entityId: query.entityId });
    }
    if (query.from || query.to) {
      filters.push({
        occurredAt: {
          ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
          ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
        },
      });
    }
    if (search.length >= 2) {
      const uuidMatch = UUID_PATTERN.test(search);
      filters.push({
        OR: [
          { actorName: { contains: search, mode: 'insensitive' } },
          { action: { contains: search, mode: 'insensitive' } },
          { entityType: { contains: search, mode: 'insensitive' } },
          { reason: { contains: search, mode: 'insensitive' } },
          ...(uuidMatch ? [{ entityId: search }, { actorUserId: search }] : []),
        ],
      });
    }
    const cursor = query.cursor && !query.page ? decodeHistoryCursor(query.cursor) : null;
    if (cursor) {
      filters.push(historyWhereAfter(cursor));
    }
    const where: Prisma.AuditLogWhereInput = filters.length > 0 ? { AND: filters } : {};
    const [totalCount, rows] = await this.prisma.client.$transaction([
      this.prisma.client.auditLog.count({ where }),
      this.prisma.client.auditLog.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: cursor ? 0 : (page - 1) * pageSize,
        take: pageSize + 1,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          parentEntityType: true,
          parentEntityId: true,
          oldValue: true,
          newValue: true,
          reason: true,
          actorUserId: true,
          actorName: true,
          occurredAt: true,
        },
      }),
    ]);
    const overflow = rows.length > pageSize;
    const pageRows = overflow ? rows.slice(0, pageSize) : rows;
    const actorParts = await loadActorNamePartsByUserId(
      this.prisma.client,
      pageRows.map((row) => row.actorUserId),
    );
    const items = pageRows.map((row) => {
      const shaped = shapeHistoryForRole(
        {
          ...row,
          requestId: null,
        },
        user.role,
      );
      const parts = shaped.actorUserId ? actorParts.get(shaped.actorUserId) : undefined;
      return {
        id: shaped.id,
        action: shaped.action,
        entityType: shaped.entityType,
        entityId: shaped.entityId,
        parentEntityType: shaped.parentEntityType,
        parentEntityId: shaped.parentEntityId,
        oldValue: scrubSensitiveValue(shaped.oldValue),
        newValue: scrubSensitiveValue(shaped.newValue),
        reason: shaped.reason,
        actorUserId: shaped.actorUserId,
        actorName: shaped.actorName,
        actorLastName: parts?.lastName ?? null,
        actorFirstName: parts?.firstName ?? null,
        actorMiddleName: parts?.middleName ?? null,
        occurredAt: shaped.occurredAt.toISOString(),
      };
    });
    return {
      items,
      page: cursor ? 1 : page,
      pageSize,
      totalCount,
      totalPages: totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize),
      nextCursor: overflow ? encodeHistoryCursor(pageRows[pageRows.length - 1]!) : null,
    };
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
    const actorParts = await loadActorNamePartsByUserId(
      this.prisma.client,
      page.map((row) => row.actorUserId),
    );
    return {
      items: page.map((row) => {
        const parts = row.actorUserId ? actorParts.get(row.actorUserId) : undefined;
        return {
          id: row.id,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          parentEntityType: row.parentEntityType,
          parentEntityId: row.parentEntityId,
          oldValue: scrubSensitiveValue(row.oldValue),
          newValue: scrubSensitiveValue(row.newValue),
          reason: row.reason,
          actorUserId: row.actorUserId,
          actorName: row.actorName,
          actorLastName: parts?.lastName ?? null,
          actorFirstName: parts?.firstName ?? null,
          actorMiddleName: parts?.middleName ?? null,
          occurredAt: row.occurredAt.toISOString(),
        };
      }),
      nextCursor: visible.length > limit ? encodeHistoryCursor(page[page.length - 1]!) : null,
      totalCount: visible.length,
    };
  }

  private normalizeDraftDefects(
    items: Array<{
      location?: string | null;
      defectTypeId?: string | null;
      workTypeId?: string | null;
      claimDetails?: string | null;
      notes?: string | null;
      responsibleEngineerId?: string | null;
      responsibleEngineerIds?: string[];
      liableOrganizationIds?: string[];
      plannedDeadline?: string | null;
      claimDeadline?: string | null;
      thirdPartyDeadline?: string | null;
    }>,
  ) {
    const normalized = [];
    for (const item of items) {
      const engineerId = singleResponsibleEngineerId(
        item.responsibleEngineerIds,
        item.responsibleEngineerId,
      );
      if (
        isBlankDraftDefect({
          ...item,
          responsibleEngineerIds: engineerId ? [engineerId] : [],
        })
      ) {
        continue;
      }
      normalized.push({
        location: normalizeDraftLocation(item.location),
        defectTypeId: item.defectTypeId ?? null,
        workTypeId: item.workTypeId ?? null,
        claimDetails: normalizeDraftClaimDetails(item.claimDetails),
        notes: normalizeDraftNotes(item.notes),
        responsibleEngineerIds: engineerId ? [engineerId] : [],
        liableOrganizationIds: item.liableOrganizationIds ?? [],
        plannedDeadline: item.plannedDeadline
          ? parseOptionalCalendarDate(item.plannedDeadline, 'plannedDeadline')
          : null,
        claimDeadline: item.claimDeadline
          ? parseOptionalCalendarDate(item.claimDeadline, 'claimDeadline')
          : null,
        thirdPartyDeadline: item.thirdPartyDeadline
          ? parseOptionalCalendarDate(item.thirdPartyDeadline, 'thirdPartyDeadline')
          : null,
      });
    }
    return normalized;
  }

  private async insertDefect(
    tx: Prisma.TransactionClient,
    actId: string,
    input: {
      location?: string | null;
      defectTypeId?: string | null;
      workTypeId?: string | null;
      claimDetails?: string | null;
      notes?: string | null;
      responsibleEngineerId?: string | null;
      responsibleEngineerIds?: string[];
      liableOrganizationIds?: string[];
      plannedDeadline?: string | null;
      claimDeadline?: string | null;
      thirdPartyDeadline?: string | null;
    },
    user: AuthenticatedUser,
    outboxIds: string[],
    draft = false,
  ): Promise<string> {
    const engineerId = singleResponsibleEngineerId(
      input.responsibleEngineerIds,
      input.responsibleEngineerId,
    );
    const engineerIds = engineerId ? [engineerId] : [];
    const liableIds = assertUniqueIds(input.liableOrganizationIds ?? [], 'liableOrganizationIds');
    if (!draft) {
      assertAtLeastOneEngineer(engineerIds.length);
    }
    if (input.defectTypeId) {
      await this.assertDefectType(tx, input.defectTypeId);
    }
    if (input.workTypeId) {
      await this.assertWorkType(tx, input.workTypeId);
    }
    await this.assertEngineers(tx, engineerIds);
    await this.assertOrganizations(tx, liableIds, true);
    const created = createDefectItem({ id: randomUUID(), actId });
    await tx.defectItem.create({
      data: {
        id: created.id,
        actId,
        location: normalizeDraftLocation(input.location),
        defectTypeId: input.defectTypeId || null,
        workTypeId: input.workTypeId || null,
        status: 'IN_PROGRESS',
        claimDetails: normalizeDraftClaimDetails(input.claimDetails),
        notes: normalizeDraftNotes(input.notes),
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
    if (!draft) {
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
    }
    return created.id;
  }

  private async assertDraftHeader(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    input: {
      objectId: string | null;
      customerOrganizationId: string | null;
      fillingEngineerId: string | null;
    },
  ) {
    if (input.objectId && input.customerOrganizationId) {
      await this.assertCreatableObject(tx, user, input.objectId);
      await this.assertActHeaderRefs(tx, input.objectId, input.customerOrganizationId);
    } else if (input.objectId) {
      await this.assertCreatableObject(tx, user, input.objectId);
      const object = await tx.propertyObject.findUnique({ where: { id: input.objectId } });
      if (!object?.active) {
        throw new ValidationError('objectId', 'Можно выбрать только активный объект');
      }
    } else if (input.customerOrganizationId) {
      const customer = await tx.organization.findUnique({
        where: { id: input.customerOrganizationId },
        include: { roles: true },
      });
      if (!customer?.active || !customer.roles.some((role) => role.role === 'CUSTOMER')) {
        throw new ValidationError(
          'customerOrganizationId',
          'Можно выбрать только активного заказчика',
        );
      }
    }
    if (input.fillingEngineerId) {
      await this.assertEngineers(tx, [input.fillingEngineerId]);
    }
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
        ...(await resolveRegistryAccessScope(this.prisma.client, user)).objectVisibleWhere(
          objectId,
        ),
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
      where: (await resolveRegistryAccessScope(this.prisma.client, user)).actVisibleWhere(actId),
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
      where: {
        id: defectItemId,
        AND: [(await resolveRegistryAccessScope(this.prisma.client, user)).defectItemWhere()],
      },
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
    const scope = await resolveRegistryAccessScope(this.prisma.client, user);
    const act = await this.prisma.client.act.findFirst({
      where: scope.actVisibleWhere(actId),
      select: {
        id: true,
        status: true,
        startedAt: true,
        objectId: true,
        customerOrganizationId: true,
        issuedOn: true,
        formCode: true,
        year: true,
        sequence: true,
        officialNumber: true,
      },
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
    const scope = await resolveRegistryAccessScope(this.prisma.client, user);
    const item = await this.prisma.client.defectItem.findFirst({
      where: { id: defectItemId, AND: [scope.defectItemWhere()] },
    });
    if (!item) {
      throw new NotFoundException('Запись не найдена');
    }
    return item;
  }

  private async assignedDefectIds(user: AuthenticatedUser, actId: string): Promise<Set<string>> {
    const scope = await resolveRegistryAccessScope(this.prisma.client, user);
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
    const status = computeActStatus(
      items.map((item) => ({ status: item.status, active: true })),
      { startedAt: act.startedAt, cancelledAt: act.cancelledAt },
      { currentStatus: act.status },
    );
    if (status === act.status) {
      return;
    }
    await tx.act.update({
      where: { id: actId },
      data: { status },
    });
  }
}

function actFormIdentityLocked(act: {
  formCode: string | null;
  year: number | null;
  sequence: number | null;
}): boolean {
  return act.formCode != null && act.year != null && act.sequence != null;
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
