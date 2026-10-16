import { randomUUID } from 'node:crypto';
import type { OrganizationRoleType, Prisma, PrismaClient } from '@prisma/client';
import {
  LEGACY_ACTS_IMPORT_LOCK_KEY1,
  LEGACY_ACTS_IMPORT_LOCK_KEY2,
  LEGACY_ACT_SOURCE_SYSTEM,
  calendarDateToUtcNoon,
  foldMatchKey,
  isLiableOrganizationRole,
  legacyDefectTypeCode,
  missingOrganizationDetailFields,
  organizationIncompleteNotificationBody,
  organizationIncompleteOccurrenceKey,
  planLegacyActsImport,
  importedEngineerMatchKey,
  parseSourceSurnameInitials,
  type LegacyActsCatalog,
  type LegacyActsImportPlan,
  type LegacyActsWorkbookParseResult,
} from '@sgr-registry/domain';
import { allocateActNumber } from './act-number';
import { insertAuditLogRow, insertOutboxEventRow } from './rls-writes';
import type { LegacyActsWorkbookFile } from './acts-xlsx';

export interface ActsImportReport {
  applied: boolean;
  databaseName: string;
  sha256: string;
  fileName: string;
  parse: LegacyActsWorkbookParseResult;
  plan: LegacyActsImportPlan;
  importBatchId: string | null;
  created: {
    acts: number;
    defects: number;
    organizations: number;
    defectTypes: number;
    liableLinks: number;
    engineerLinks: number;
    unresolvedEngineerReferences: number;
  };
  unchanged: { acts: number; defects: number };
  preservation: DataPreservationSnapshot;
  preservationAfter?: DataPreservationSnapshot;
}

export interface DataPreservationSnapshot {
  users: number;
  credentials: number;
  roles: Record<string, number>;
  objects: number;
  organizations: number;
  acts: number;
  defectItems: number;
  proposals: number;
  attachments: number;
  auditLogs: number;
  passwordFingerprint: string;
}

function utcDateOnly(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

export async function captureDataPreservationSnapshot(
  prisma: PrismaClient,
): Promise<DataPreservationSnapshot> {
  const [
    users,
    credentials,
    objects,
    organizations,
    acts,
    defectItems,
    proposals,
    attachments,
    auditLogs,
    userRows,
    credentialRows,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.userCredential.count(),
    prisma.propertyObject.count(),
    prisma.organization.count(),
    prisma.act.count(),
    prisma.defectItem.count(),
    prisma.proposal.count(),
    prisma.attachment.count(),
    prisma.auditLog.count(),
    prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
    prisma.userCredential.findMany({ select: { passwordHash: true }, orderBy: { userId: 'asc' } }),
  ]);
  const roles: Record<string, number> = {};
  for (const row of userRows) {
    roles[row.role] = row._count._all;
  }
  const { createHash } = await import('node:crypto');
  const fingerprint = createHash('sha256');
  for (const row of credentialRows) {
    fingerprint.update(createHash('sha256').update(row.passwordHash, 'utf8').digest('hex'));
  }
  return {
    users,
    credentials,
    roles,
    objects,
    organizations,
    acts,
    defectItems,
    proposals,
    attachments,
    auditLogs,
    passwordFingerprint: fingerprint.digest('hex').slice(0, 32),
  };
}

async function loadCatalog(
  prisma: PrismaClient | Prisma.TransactionClient,
): Promise<LegacyActsCatalog> {
  const [objects, organizations, engineers, defectTypes, existingActs, existingDefects] =
    await Promise.all([
      prisma.propertyObject.findMany({ select: { id: true, name: true, address: true } }),
      prisma.organization.findMany({
        select: {
          id: true,
          officialName: true,
          unp: true,
          roles: { select: { role: true } },
        },
      }),
      prisma.user.findMany({
        select: { id: true, fullName: true, role: true, status: true },
      }),
      prisma.defectType.findMany({
        select: { id: true, name: true, active: true, sortOrder: true },
      }),
      prisma.act.findMany({
        where: { sourceSystem: LEGACY_ACT_SOURCE_SYSTEM },
        select: {
          id: true,
          sourceSystem: true,
          sourceImportKey: true,
          formCode: true,
          issuedOn: true,
          objectId: true,
          customerOrganizationId: true,
          status: true,
          officialNumber: true,
          sourceActNumberRaw: true,
          sourceStatusRaw: true,
          sourceExternalUrl: true,
          sourceRows: true,
        },
      }),
      prisma.defectItem.findMany({
        where: { sourceSystem: LEGACY_ACT_SOURCE_SYSTEM },
        select: {
          id: true,
          actId: true,
          sourceSystem: true,
          sourceImportKey: true,
          location: true,
          plannedDeadline: true,
          sourceDeadlineRaw: true,
          defectType: { select: { name: true } },
          liableOrganizations: { select: { organizationId: true } },
          responsibleEngineers: { select: { userId: true } },
          importedEngineerReferences: {
            where: { resolutionStatus: 'UNMATCHED' },
            select: { nameMatchKey: true },
          },
        },
      }),
    ]);
  return {
    objects,
    organizations: organizations.map((row) => ({
      id: row.id,
      officialName: row.officialName,
      unp: row.unp,
      roles: row.roles.map((item) => item.role),
    })),
    engineers,
    defectTypes,
    existingActs: existingActs.map((row) => ({
      id: row.id,
      sourceSystem: row.sourceSystem,
      sourceImportKey: row.sourceImportKey,
      formCode: row.formCode,
      issuedOn: row.issuedOn ? utcDateOnly(row.issuedOn) : null,
      objectId: row.objectId,
      customerOrganizationId: row.customerOrganizationId,
      status: row.status,
      officialNumber: row.officialNumber,
      sourceActNumberRaw: row.sourceActNumberRaw,
      sourceStatusRaw: row.sourceStatusRaw,
      sourceExternalUrl: row.sourceExternalUrl,
      sourceRows: row.sourceRows,
    })),
    existingDefects: existingDefects.map((row) => ({
      id: row.id,
      actId: row.actId,
      sourceSystem: row.sourceSystem,
      sourceImportKey: row.sourceImportKey,
      location: row.location,
      defectTypeName: row.defectType?.name ?? null,
      plannedDeadline: row.plannedDeadline ? utcDateOnly(row.plannedDeadline) : null,
      sourceDeadlineRaw: row.sourceDeadlineRaw,
      liableOrganizationIds: row.liableOrganizations.map((item) => item.organizationId),
      engineerIds: row.responsibleEngineers.map((item) => item.userId),
      unresolvedEngineerKeys: row.importedEngineerReferences.map((item) => item.nameMatchKey),
    })),
  };
}

async function audit(
  tx: Prisma.TransactionClient,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    parentEntityType?: string | null;
    parentEntityId?: string | null;
    newValue: Prisma.InputJsonValue;
  },
): Promise<void> {
  await insertAuditLogRow(tx, {
    actorUserId: null,
    actorName: 'SYSTEM',
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    parentEntityType: input.parentEntityType ?? null,
    parentEntityId: input.parentEntityId ?? null,
    oldValue: null,
    newValue: input.newValue,
    reason: null,
    source: 'SYSTEM',
    occurredAt: new Date(),
    ipAddress: null,
    requestId: null,
  });
}

async function ensureOrganization(
  tx: Prisma.TransactionClient,
  input: {
    name: string;
    role: OrganizationRoleType;
    created: Map<string, string>;
    notify: Set<string>;
  },
): Promise<string> {
  const key = foldMatchKey(input.name);
  const cached = input.created.get(key);
  if (cached) {
    return cached;
  }
  const existing = await tx.organization.findMany({
    select: { id: true, officialName: true, roles: { select: { role: true } } },
  });
  const match = existing.filter((row) => foldMatchKey(row.officialName) === key);
  if (match.length > 1) {
    throw new Error(`Неоднозначная организация «${input.name}»`);
  }
  if (match[0]) {
    input.created.set(key, match[0].id);
    return match[0].id;
  }
  const created = await tx.organization.create({
    data: {
      officialName: input.name,
      active: true,
      roles: { create: [{ role: input.role }] },
    },
  });
  await audit(tx, {
    action: 'ORGANIZATION_CREATED',
    entityType: 'ORGANIZATION',
    entityId: created.id,
    newValue: { officialName: input.name, role: input.role, source: LEGACY_ACT_SOURCE_SYSTEM },
  });
  input.created.set(key, created.id);
  input.notify.add(created.id);
  return created.id;
}

async function ensureDefectType(
  tx: Prisma.TransactionClient,
  name: string,
  created: Map<string, string>,
  sortOrder: number,
): Promise<string> {
  const key = foldMatchKey(name);
  const cached = created.get(key);
  if (cached) {
    return cached;
  }
  const existing = await tx.defectType.findMany({
    select: { id: true, name: true, active: true, code: true },
  });
  const matches = existing.filter((row) => row.active && foldMatchKey(row.name) === key);
  if (matches.length > 1) {
    throw new Error(`Неоднозначный вид дефекта «${name}»`);
  }
  if (matches[0]) {
    created.set(key, matches[0].id);
    return matches[0].id;
  }
  const code = legacyDefectTypeCode(
    name,
    existing.map((row) => row.code),
  );
  const createdType = await tx.defectType.create({
    data: { name, code, sortOrder, active: true },
  });
  await audit(tx, {
    action: 'DEFECT_TYPE_CREATED',
    entityType: 'DEFECT_TYPE',
    entityId: createdType.id,
    newValue: { name, code, source: LEGACY_ACT_SOURCE_SYSTEM },
  });
  created.set(key, createdType.id);
  return createdType.id;
}

async function notifyIncompleteOrganizations(
  tx: Prisma.TransactionClient,
  organizationIds: string[],
): Promise<void> {
  if (organizationIds.length === 0) {
    return;
  }
  const staff = await tx.user.findMany({
    where: { status: 'ACTIVE', role: { in: ['ADMIN', 'MANAGER'] } },
    select: { id: true },
  });
  const extraRecipientIds = staff.map((row) => row.id);
  for (const organizationId of organizationIds) {
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      include: { roles: true },
    });
    const occurrenceKey = organizationIncompleteOccurrenceKey(organizationId);
    const existing = await tx.notificationEvent.findUnique({
      where: { occurrenceKey },
      select: { id: true },
    });
    if (existing) {
      continue;
    }
    const details = {
      officialName: organization.officialName,
      unp: organization.unp,
      postalAddress: organization.postalAddress,
      email: organization.email,
      phone: organization.phone,
      contactPerson: organization.contactPerson,
    };
    await insertOutboxEventRow(tx, {
      id: randomUUID(),
      type: 'ORGANIZATION_DETAILS_INCOMPLETE',
      payload: {
        type: 'ORGANIZATION_DETAILS_INCOMPLETE',
        occurrenceBase: occurrenceKey,
        actId: null,
        defectItemId: null,
        attachmentId: null,
        actorUserId: null,
        automatic: true,
        extraRecipientIds,
        body: organizationIncompleteNotificationBody({
          officialName: organization.officialName,
          missingFields: missingOrganizationDetailFields(details),
          liable: isLiableOrganizationRole(organization.roles.map((item) => item.role)),
        }),
        kind: null,
        cycle: null,
        deadline: null,
        threshold: null,
        organizationId,
        missingFields: missingOrganizationDetailFields(details),
      },
    });
  }
}

export async function importLegacyActs(options: {
  prisma: PrismaClient;
  workbook: LegacyActsWorkbookFile;
  apply: boolean;
  databaseName: string;
  environment: string;
  expectSha256?: string;
}): Promise<ActsImportReport> {
  if (options.expectSha256 && options.expectSha256 !== options.workbook.sha256) {
    throw new Error(
      `SHA-256 файла ${options.workbook.sha256} не совпадает с ожидаемым ${options.expectSha256}`,
    );
  }
  const preservation = await captureDataPreservationSnapshot(options.prisma);
  const catalog = await loadCatalog(options.prisma);
  const plan = planLegacyActsImport(options.workbook.parse, catalog);
  const report: ActsImportReport = {
    applied: false,
    databaseName: options.databaseName,
    sha256: options.workbook.sha256,
    fileName: options.workbook.fileName,
    parse: options.workbook.parse,
    plan,
    importBatchId: null,
    created: {
      acts: plan.actsToCreate,
      defects: plan.defectsToCreate,
      organizations: plan.customersToCreate.length + plan.liableOrganizationsToCreate.length,
      defectTypes: plan.defectTypesToCreate.length,
      liableLinks: plan.liableLinksToCreate,
      engineerLinks: plan.engineerLinksToCreate,
      unresolvedEngineerReferences: plan.unresolvedEngineerLinksToCreate,
    },
    unchanged: { acts: plan.actsUnchanged, defects: plan.defectsUnchanged },
    preservation,
  };

  if (!options.apply) {
    return report;
  }
  if (plan.blockingIssues.length > 0) {
    throw new Error(`Импорт заблокирован:\n${plan.blockingIssues.join('\n')}`);
  }

  const applied = await options.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEGACY_ACTS_IMPORT_LOCK_KEY1}, ${LEGACY_ACTS_IMPORT_LOCK_KEY2})`;
    const lockedCatalog = await loadCatalog(tx);
    const lockedPlan = planLegacyActsImport(options.workbook.parse, lockedCatalog);
    if (lockedPlan.blockingIssues.length > 0) {
      throw new Error(`Импорт заблокирован:\n${lockedPlan.blockingIssues.join('\n')}`);
    }
    const batchId = randomUUID();
    const startedAt = new Date();
    await tx.importBatch.create({
      data: {
        id: batchId,
        sourceSystem: LEGACY_ACT_SOURCE_SYSTEM,
        sourceFileName: options.workbook.fileName,
        sourceFileSha256: options.workbook.sha256,
        sourceSheet: options.workbook.parse.sheetName,
        environment: options.environment,
        databaseName: options.databaseName,
        status: 'STARTED',
        startedAt,
      },
    });
    await audit(tx, {
      action: 'LEGACY_ACT_IMPORT_BATCH_STARTED',
      entityType: 'IMPORT_BATCH',
      entityId: batchId,
      newValue: {
        sourceSystem: LEGACY_ACT_SOURCE_SYSTEM,
        sourceFileName: options.workbook.fileName,
        sourceFileSha256: options.workbook.sha256,
        sourceRows: options.workbook.parse.sourceRows,
        databaseName: options.databaseName,
      },
    });

    const orgIds = new Map<string, string>();
    const createdOrgIds = new Set<string>();
    const defectTypeIds = new Map<string, string>();
    let createdDefectTypes = 0;
    let createdActs = 0;
    let createdDefects = 0;
    let unchangedActs = 0;
    let unchangedDefects = 0;
    let liableLinks = 0;
    let engineerLinks = 0;
    let unresolvedEngineerLinks = 0;
    let nextDefectTypeOrder =
      Math.max(0, ...lockedCatalog.defectTypes.map((item) => item.sortOrder)) + 1;

    for (const name of lockedPlan.customersToCreate) {
      await ensureOrganization(tx, {
        name,
        role: 'CUSTOMER',
        created: orgIds,
        notify: createdOrgIds,
      });
    }
    for (const name of lockedPlan.liableOrganizationsToCreate) {
      await ensureOrganization(tx, {
        name,
        role: 'LIABLE_CONTRACTOR',
        created: orgIds,
        notify: createdOrgIds,
      });
    }
    for (const name of lockedPlan.defectTypesToCreate) {
      const before = defectTypeIds.size;
      await ensureDefectType(tx, name, defectTypeIds, nextDefectTypeOrder);
      if (
        defectTypeIds.size > before &&
        !lockedCatalog.defectTypes.some((item) => foldMatchKey(item.name) === foldMatchKey(name))
      ) {
        createdDefectTypes += 1;
        nextDefectTypeOrder += 1;
      }
    }

    for (const actPlan of lockedPlan.acts) {
      if (actPlan.action === 'unchanged') {
        unchangedActs += 1;
        unchangedDefects += actPlan.defects.filter((item) => item.action === 'unchanged').length;
        continue;
      }
      if (actPlan.action !== 'create') {
        throw new Error(`Неожиданное действие акта ${actPlan.action}`);
      }
      const object = actPlan.object;
      if (!object) {
        throw new Error(`Объект не сопоставлен: ${actPlan.group.objectNameRaw}`);
      }
      let customerId = actPlan.customer?.id;
      if (!customerId) {
        customerId = await ensureOrganization(tx, {
          name: actPlan.group.customerNameRaw,
          role: 'CUSTOMER',
          created: orgIds,
          notify: createdOrgIds,
        });
      }
      const issuedAt = calendarDateToUtcNoon(actPlan.group.issuedOn);
      const number = await allocateActNumber(tx, actPlan.group.formCode, issuedAt);
      const actId = randomUUID();
      await tx.act.create({
        data: {
          id: actId,
          officialNumber: actPlan.group.actNumberRaw?.trim() || null,
          formCode: number.formCode,
          year: number.year,
          sequence: number.sequence,
          objectId: object.id,
          customerOrganizationId: customerId,
          issuedOn: issuedAt,
          createdAt: issuedAt,
          signedDocumentRef: actPlan.group.documentUrl,
          status: actPlan.group.status,
          sourceSystem: LEGACY_ACT_SOURCE_SYSTEM,
          sourceFileName: options.workbook.fileName,
          sourceFileSha256: options.workbook.sha256,
          sourceSheet: options.workbook.parse.sheetName,
          sourceRows: actPlan.group.sourceRows,
          sourceExternalUrl: actPlan.group.documentUrl,
          sourceActNumberRaw: actPlan.group.actNumberRaw,
          sourceStatusRaw: actPlan.group.statusRaw,
          sourceImportKey: actPlan.sourceImportKey,
          importedAt: startedAt,
          importBatchId: batchId,
        },
      });
      createdActs += 1;
      await audit(tx, {
        action: 'LEGACY_ACT_IMPORTED',
        entityType: 'ACT',
        entityId: actId,
        parentEntityType: 'IMPORT_BATCH',
        parentEntityId: batchId,
        newValue: {
          sourceImportKey: actPlan.sourceImportKey,
          sourceExternalUrl: actPlan.group.documentUrl,
          sourceRows: actPlan.group.sourceRows,
          status: actPlan.group.status,
          importBatchId: batchId,
        },
      });

      for (const defectPlan of actPlan.defects) {
        if (defectPlan.action === 'unchanged') {
          unchangedDefects += 1;
          continue;
        }
        if (defectPlan.action !== 'create') {
          throw new Error(`Неожиданное действие дефекта ${defectPlan.action}`);
        }
        let defectTypeId = defectPlan.defectType?.id;
        if (!defectTypeId) {
          defectTypeId = await ensureDefectType(
            tx,
            defectPlan.group.defectTypeNameRaw,
            defectTypeIds,
            nextDefectTypeOrder,
          );
          nextDefectTypeOrder += 1;
        }
        const defectId = randomUUID();
        await tx.defectItem.create({
          data: {
            id: defectId,
            actId,
            location: defectPlan.group.location,
            defectTypeId,
            workTypeId: null,
            status: 'IN_PROGRESS',
            claimDetails: null,
            createdAt: issuedAt,
            plannedDeadline: defectPlan.group.plannedDeadline
              ? calendarDateToUtcNoon(defectPlan.group.plannedDeadline)
              : null,
            sourceSystem: LEGACY_ACT_SOURCE_SYSTEM,
            sourceFileName: options.workbook.fileName,
            sourceFileSha256: options.workbook.sha256,
            sourceSheet: options.workbook.parse.sheetName,
            sourceRows: defectPlan.group.sourceRows,
            sourceDeadlineRaw: defectPlan.group.deadlineRaw,
            sourceImportKey: defectPlan.sourceImportKey,
            importedAt: startedAt,
            importBatchId: batchId,
          },
        });
        createdDefects += 1;
        for (const liable of defectPlan.liableOrganizations) {
          const organizationId =
            liable.action === 'link'
              ? liable.organization.id
              : await ensureOrganization(tx, {
                  name: liable.name,
                  role: 'LIABLE_CONTRACTOR',
                  created: orgIds,
                  notify: createdOrgIds,
                });
          await tx.defectItemLiableOrganization.create({
            data: { defectItemId: defectId, organizationId },
          });
          liableLinks += 1;
        }
        for (const engineer of defectPlan.engineers) {
          if (engineer.result === 'MATCHED') {
            await tx.defectItemEngineer.create({
              data: { defectItemId: defectId, userId: engineer.userId },
            });
            engineerLinks += 1;
            await audit(tx, {
              action: 'IMPORTED_ENGINEER_MATCHED',
              entityType: 'DEFECT_ITEM',
              entityId: defectId,
              parentEntityType: 'ACT',
              parentEntityId: actId,
              newValue: {
                sourceNameRaw: engineer.name,
                matchedUserId: engineer.userId,
                importBatchId: batchId,
              },
            });
            continue;
          }
          const parsedName = parseSourceSurnameInitials(engineer.name);
          if (!parsedName) {
            throw new Error(`Некорректное ФИО инженера «${engineer.name}»`);
          }
          await tx.importedEngineerReference.create({
            data: {
              id: randomUUID(),
              defectItemId: defectId,
              importBatchId: batchId,
              sourceNameRaw: engineer.name,
              nameMatchKey: importedEngineerMatchKey(engineer.name),
              normalizedSurname: parsedName.surname,
              firstInitial: parsedName.firstInitial,
              middleInitial: parsedName.patronymicInitial,
              resolutionStatus: 'UNMATCHED',
            },
          });
          unresolvedEngineerLinks += 1;
          await audit(tx, {
            action: 'IMPORTED_ENGINEER_UNMATCHED',
            entityType: 'DEFECT_ITEM',
            entityId: defectId,
            parentEntityType: 'ACT',
            parentEntityId: actId,
            newValue: {
              sourceNameRaw: engineer.name,
              importBatchId: batchId,
            },
          });
        }
        await audit(tx, {
          action: 'LEGACY_DEFECT_IMPORTED',
          entityType: 'DEFECT_ITEM',
          entityId: defectId,
          parentEntityType: 'ACT',
          parentEntityId: actId,
          newValue: {
            sourceImportKey: defectPlan.sourceImportKey,
            sourceRows: defectPlan.group.sourceRows,
            importBatchId: batchId,
          },
        });
      }
    }

    await notifyIncompleteOrganizations(tx, [...createdOrgIds]);
    await tx.importBatch.update({
      where: { id: batchId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        createdActs,
        createdDefects,
        unchangedActs,
        unchangedDefects,
        createdOrganizations: createdOrgIds.size,
        createdDefectTypes,
        stats: {
          liableLinks,
          engineerLinks,
          unresolvedEngineerReferences: unresolvedEngineerLinks,
          createdOrganizationIds: [...createdOrgIds],
          createdDefectTypeIds: [...defectTypeIds.values()].filter(
            (id) => !lockedCatalog.defectTypes.some((item) => item.id === id),
          ),
          createdOrgNotifications: createdOrgIds.size,
        },
      },
    });
    await audit(tx, {
      action: 'LEGACY_ACT_IMPORT_BATCH_COMPLETED',
      entityType: 'IMPORT_BATCH',
      entityId: batchId,
      newValue: {
        createdActs,
        createdDefects,
        unchangedActs,
        unchangedDefects,
        createdOrganizations: createdOrgIds.size,
        createdDefectTypes,
        unresolvedEngineerReferences: unresolvedEngineerLinks,
      },
    });
    return {
      batchId,
      createdActs,
      createdDefects,
      unchangedActs,
      unchangedDefects,
      createdOrganizations: createdOrgIds.size,
      createdDefectTypes,
      liableLinks,
      engineerLinks,
      unresolvedEngineerLinks,
      plan: lockedPlan,
    };
  });

  return {
    ...report,
    applied: true,
    plan: applied.plan,
    importBatchId: applied.batchId,
    created: {
      acts: applied.createdActs,
      defects: applied.createdDefects,
      organizations: applied.createdOrganizations,
      defectTypes: applied.createdDefectTypes,
      liableLinks: applied.liableLinks,
      engineerLinks: applied.engineerLinks,
      unresolvedEngineerReferences: applied.unresolvedEngineerLinks,
    },
    unchanged: { acts: applied.unchangedActs, defects: applied.unchangedDefects },
    preservationAfter: await captureDataPreservationSnapshot(options.prisma),
  };
}

export interface ActsImportRollbackReport {
  rolledBack: boolean;
  alreadyRolledBack: boolean;
  importBatchId: string;
  databaseName: string;
  deleted: {
    acts: number;
    defects: number;
    engineerAssignments: number;
    unresolvedEngineerReferences: number;
    liableLinks: number;
    organizations: number;
    defectTypes: number;
  };
}

function asIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export async function rollbackLegacyActsImportBatch(options: {
  prisma: PrismaClient;
  importBatchId: string;
  databaseName: string;
  environment: string;
}): Promise<ActsImportRollbackReport> {
  if (options.environment === 'production') {
    throw new Error('Rollback of imported acts is disabled in production.');
  }
  const empty = {
    acts: 0,
    defects: 0,
    engineerAssignments: 0,
    unresolvedEngineerReferences: 0,
    liableLinks: 0,
    organizations: 0,
    defectTypes: 0,
  };
  const result = await options.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEGACY_ACTS_IMPORT_LOCK_KEY1}, ${LEGACY_ACTS_IMPORT_LOCK_KEY2})`;
    const batch = await tx.importBatch.findUnique({ where: { id: options.importBatchId } });
    if (!batch) {
      return { alreadyRolledBack: true, deleted: empty };
    }
    if (batch.status === 'ROLLED_BACK') {
      return { alreadyRolledBack: true, deleted: empty };
    }
    if (batch.environment === 'production' || options.environment === 'production') {
      throw new Error('Rollback of imported acts is disabled in production.');
    }
    if (batch.databaseName !== options.databaseName) {
      throw new Error(
        `Batch ${batch.id} belongs to database ${batch.databaseName}, not ${options.databaseName}.`,
      );
    }
    const acts = await tx.act.findMany({
      where: { importBatchId: batch.id },
      select: { id: true },
    });
    const actIds = acts.map((row) => row.id);
    const defects = await tx.defectItem.findMany({
      where: { importBatchId: batch.id },
      select: { id: true },
    });
    const defectIds = defects.map((row) => row.id);
    const stats = (batch.stats ?? {}) as Record<string, unknown>;
    const createdOrganizationIds = asIdList(stats.createdOrganizationIds);
    const createdDefectTypeIds = asIdList(stats.createdDefectTypeIds);

    const engineerAssignments =
      defectIds.length > 0
        ? await tx.defectItemEngineer.deleteMany({
            where: { defectItemId: { in: defectIds } },
          })
        : { count: 0 };
    const unresolved = await tx.importedEngineerReference.deleteMany({
      where: { importBatchId: batch.id },
    });
    const liableLinks =
      defectIds.length > 0
        ? await tx.defectItemLiableOrganization.deleteMany({
            where: { defectItemId: { in: defectIds } },
          })
        : { count: 0 };
    if (defectIds.length > 0) {
      await tx.slaClock.deleteMany({ where: { defectItemId: { in: defectIds } } });
      const events = await tx.notificationEvent.findMany({
        where: { OR: [{ defectItemId: { in: defectIds } }, { actId: { in: actIds } }] },
        select: { id: true },
      });
      const eventIds = events.map((row) => row.id);
      if (eventIds.length > 0) {
        const recipients = await tx.notificationRecipient.findMany({
          where: { notificationEventId: { in: eventIds } },
          select: { id: true },
        });
        const recipientIds = recipients.map((row) => row.id);
        if (recipientIds.length > 0) {
          await tx.emailDelivery.deleteMany({
            where: { notificationRecipientId: { in: recipientIds } },
          });
        }
        await tx.notificationRecipient.deleteMany({
          where: { notificationEventId: { in: eventIds } },
        });
        await tx.notificationEvent.deleteMany({ where: { id: { in: eventIds } } });
      }
      await tx.proposal.deleteMany({ where: { defectItemId: { in: defectIds } } });
      await tx.attachment.deleteMany({
        where: { OR: [{ defectItemId: { in: defectIds } }, { actId: { in: actIds } }] },
      });
    }
    if (actIds.length > 0) {
      await tx.actChatMention.deleteMany({
        where: { message: { actId: { in: actIds } } },
      });
      await tx.actChatMessage.deleteMany({ where: { actId: { in: actIds } } });
    }
    const deletedDefects =
      defectIds.length > 0
        ? await tx.defectItem.deleteMany({
            where: { id: { in: defectIds } },
          })
        : { count: 0 };
    const deletedActs =
      actIds.length > 0 ? await tx.act.deleteMany({ where: { id: { in: actIds } } }) : { count: 0 };

    let deletedOrgs = 0;
    for (const organizationId of createdOrganizationIds) {
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              customerActs: true,
              liableItems: true,
              proposals: true,
            },
          },
        },
      });
      if (!organization) {
        continue;
      }
      if (organization.updatedAt.getTime() - organization.createdAt.getTime() > 2000) {
        continue;
      }
      if (
        organization._count.customerActs > 0 ||
        organization._count.liableItems > 0 ||
        organization._count.proposals > 0
      ) {
        continue;
      }
      await tx.organizationRoleAssignment.deleteMany({ where: { organizationId } });
      await tx.organizationWorkType.deleteMany({ where: { organizationId } });
      await tx.organization.delete({ where: { id: organizationId } });
      deletedOrgs += 1;
    }

    let deletedDefectTypes = 0;
    for (const defectTypeId of createdDefectTypeIds) {
      const defectType = await tx.defectType.findUnique({
        where: { id: defectTypeId },
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { defectItems: true } },
        },
      });
      if (!defectType || defectType._count.defectItems > 0) {
        continue;
      }
      if (defectType.updatedAt.getTime() - defectType.createdAt.getTime() > 2000) {
        continue;
      }
      await tx.defectType.delete({ where: { id: defectTypeId } });
      deletedDefectTypes += 1;
    }

    await tx.importBatch.update({
      where: { id: batch.id },
      data: {
        status: 'ROLLED_BACK',
        stats: {
          ...stats,
          rolledBackAt: new Date().toISOString(),
          rolledBackDatabase: options.databaseName,
        },
      },
    });
    await audit(tx, {
      action: 'LEGACY_ACT_IMPORT_BATCH_ROLLED_BACK',
      entityType: 'IMPORT_BATCH',
      entityId: batch.id,
      newValue: {
        deletedActs: deletedActs.count,
        deletedDefects: deletedDefects.count,
        databaseName: options.databaseName,
      },
    });
    return {
      alreadyRolledBack: false,
      deleted: {
        acts: deletedActs.count,
        defects: deletedDefects.count,
        engineerAssignments: engineerAssignments.count,
        unresolvedEngineerReferences: unresolved.count,
        liableLinks: liableLinks.count,
        organizations: deletedOrgs,
        defectTypes: deletedDefectTypes,
      },
    };
  });

  return {
    rolledBack: true,
    alreadyRolledBack: result.alreadyRolledBack,
    importBatchId: options.importBatchId,
    databaseName: options.databaseName,
    deleted: result.deleted,
  };
}
