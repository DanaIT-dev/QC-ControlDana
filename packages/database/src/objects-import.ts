import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  OBJECTS_SOURCE_SYSTEM,
  calendarDateToUtcNoon,
  classifyResponsibleEngineerName,
  planPropertyObjectsImport,
  type ObjectsImportPlan,
  type ObjectsWorkbookParseResult,
  type ParsedObjectImportRow,
  type ResponsibleEngineerLinkStatus,
} from '@sgr-registry/domain';
import { insertAuditLogRow } from './rls-writes';

export interface ObjectsImportReport {
  plan: ObjectsImportPlan;
  applied: boolean;
  created: number;
  updated: number;
  unchanged: number;
  duplicatesSkipped: number;
  conflicts: ObjectsImportPlan['conflicts'];
  responsibleEngineers: {
    sourceNames: string[];
    linked: string[];
    unresolved: string[];
    ambiguous: string[];
    empty: number;
    accessAssignmentsCreated: number;
  };
  usersCountBefore: number;
  usersCountAfter: number;
  credentialsCountBefore: number;
  credentialsCountAfter: number;
  assignmentCountBefore: number;
  assignmentCountAfter: number;
  actLinks: Array<{ id: string; objectId: string }>;
}

function utcDateOnly(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

function calendarOf(value: Date | null): string | null {
  return value ? utcDateOnly(value) : null;
}

function dateValue(iso: string | null): Date | null {
  return iso ? calendarDateToUtcNoon(iso) : null;
}

async function loadExisting(prisma: PrismaClient) {
  const rows = await prisma.propertyObject.findMany({
    select: {
      id: true,
      name: true,
      address: true,
      commissionedAt: true,
      warrantyEndsAt: true,
      sortOrder: true,
      sourceResponsibleEngineerName: true,
      sourceSystem: true,
      sourceRow: true,
      sourceImportKey: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    address: row.address,
    commissionedAt: calendarOf(row.commissionedAt),
    warrantyEndsAt: calendarOf(row.warrantyEndsAt),
    sortOrder: row.sortOrder,
    sourceResponsibleEngineerName: row.sourceResponsibleEngineerName,
    sourceSystem: row.sourceSystem,
    sourceRow: row.sourceRow,
    sourceImportKey: row.sourceImportKey,
  }));
}

function classifyEngineers(
  rows: readonly ParsedObjectImportRow[],
  candidates: Array<{ fullName: string; role: string; status: string }>,
) {
  const sourceNames = [
    ...new Set(
      rows
        .map((row) => row.sourceResponsibleEngineerName)
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort((a, b) => a.localeCompare(b, 'ru'));
  const linked: string[] = [];
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  let empty = 0;
  for (const row of rows) {
    const status: ResponsibleEngineerLinkStatus = classifyResponsibleEngineerName(
      row.sourceResponsibleEngineerName,
      candidates,
    );
    if (status === 'EMPTY') {
      empty += 1;
      continue;
    }
    const name = row.sourceResponsibleEngineerName;
    if (!name) {
      continue;
    }
    if (status === 'LINKED' && !linked.includes(name)) {
      linked.push(name);
    } else if (status === 'AMBIGUOUS' && !ambiguous.includes(name)) {
      ambiguous.push(name);
    } else if (status === 'UNRESOLVED' && !unresolved.includes(name)) {
      unresolved.push(name);
    }
  }
  return { sourceNames, linked, unresolved, ambiguous, empty, accessAssignmentsCreated: 0 };
}

export async function importPropertyObjects(options: {
  prisma: PrismaClient;
  parsed: ObjectsWorkbookParseResult;
  apply: boolean;
  expectUnique?: number;
}): Promise<ObjectsImportReport> {
  if (
    options.expectUnique !== undefined &&
    options.parsed.uniqueRows.length !== options.expectUnique
  ) {
    throw new Error(
      `Expected ${options.expectUnique} unique rows, parsed ${options.parsed.uniqueRows.length}`,
    );
  }
  const existing = await loadExisting(options.prisma);
  const plan = planPropertyObjectsImport(options.parsed, existing);
  const usersCountBefore = await options.prisma.user.count();
  const credentialsCountBefore = await options.prisma.userCredential.count();
  const assignmentCountBefore = await options.prisma.propertyObjectEngineer.count();
  const actLinks = await options.prisma.act.findMany({ select: { id: true, objectId: true } });
  const engineers = await options.prisma.user.findMany({
    where: { role: 'RESPONSIBLE_ENGINEER' },
    select: { fullName: true, role: true, status: true },
  });
  const responsibleEngineers = classifyEngineers(options.parsed.uniqueRows, engineers);

  if (!options.apply) {
    return {
      plan,
      applied: false,
      created: plan.create,
      updated: plan.update,
      unchanged: plan.unchanged,
      duplicatesSkipped: plan.duplicatesSkipped,
      conflicts: plan.conflicts,
      responsibleEngineers,
      usersCountBefore,
      usersCountAfter: usersCountBefore,
      credentialsCountBefore,
      credentialsCountAfter: credentialsCountBefore,
      assignmentCountBefore,
      assignmentCountAfter: assignmentCountBefore,
      actLinks,
    };
  }

  await options.prisma.$transaction(async (tx) => {
    for (const item of plan.items) {
      if (item.action === 'create' && item.row) {
        await tx.propertyObject.create({
          data: {
            name: item.row.name,
            address: item.row.address,
            commissionedAt: dateValue(item.row.commissionedAt),
            warrantyEndsAt: dateValue(item.row.warrantyEndsAt),
            sortOrder: item.row.sourceRow,
            sourceResponsibleEngineerName: item.row.sourceResponsibleEngineerName,
            sourceSystem: OBJECTS_SOURCE_SYSTEM,
            sourceRow: item.row.sourceRow,
            sourceImportKey: item.row.sourceImportKey,
          },
        });
      }
      if (item.action === 'update' && item.row && item.existingId) {
        await tx.propertyObject.update({
          where: { id: item.existingId },
          data: {
            name: item.row.name,
            address: item.row.address,
            commissionedAt: dateValue(item.row.commissionedAt),
            warrantyEndsAt: dateValue(item.row.warrantyEndsAt),
            sortOrder: item.row.sourceRow,
            sourceResponsibleEngineerName: item.row.sourceResponsibleEngineerName,
            sourceSystem: OBJECTS_SOURCE_SYSTEM,
            sourceRow: item.row.sourceRow,
            sourceImportKey: item.row.sourceImportKey,
            version: { increment: 1 },
          },
        });
      }
    }
    await insertAuditLogRow(tx, {
      actorUserId: null,
      actorName: 'objects-import',
      action: 'PROPERTY_OBJECTS_IMPORTED',
      entityType: 'PROPERTY_OBJECT',
      entityId: randomUUID(),
      parentEntityType: null,
      parentEntityId: null,
      oldValue: null,
      newValue: {
        sourceSystem: OBJECTS_SOURCE_SYSTEM,
        created: plan.create,
        updated: plan.update,
        unchanged: plan.unchanged,
        duplicatesSkipped: plan.duplicatesSkipped,
        conflicts: plan.conflicts.length,
      },
      reason: null,
      source: 'SYSTEM',
      occurredAt: new Date(),
      ipAddress: null,
      requestId: null,
    });
  });

  return {
    plan,
    applied: true,
    created: plan.create,
    updated: plan.update,
    unchanged: plan.unchanged,
    duplicatesSkipped: plan.duplicatesSkipped,
    conflicts: plan.conflicts,
    responsibleEngineers,
    usersCountBefore,
    usersCountAfter: await options.prisma.user.count(),
    credentialsCountBefore,
    credentialsCountAfter: await options.prisma.userCredential.count(),
    assignmentCountBefore,
    assignmentCountAfter: await options.prisma.propertyObjectEngineer.count(),
    actLinks,
  };
}
