import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  APPROVED_DEFECT_TYPES_SOURCE,
  ORGANIZATIONS_SHEET_NAME,
  WORK_TYPES_SHEET_NAME,
  mergeWorkTypeSources,
  parseActOrganizationRoles,
  parseOrganizationWorkTypeColumn,
  parseOrganizationsMatrix,
  planApprovedDefectTypesSync,
  planCodedDirectorySync,
  planOrganizationSync,
  workTypeCodeForName,
  type DirectoryCodedItem,
} from '@sgr-registry/domain';
import { insertAuditLogRow } from './rls-writes';
import type { DirectoriesWorkbookSheets } from './directories-xlsx';

export interface DirectoriesImportReport {
  applied: boolean;
  defectTypes: {
    source: typeof APPROVED_DEFECT_TYPES_SOURCE;
    approvedCount: number;
    created: number;
    updated: number;
    unchanged: number;
    active: number;
    duplicates: number;
    unexpected: number;
    exactOrder: boolean;
  };
  workTypes: {
    sheet: string;
    sourceRows: number;
    created: number;
    updated: number;
    unchanged: number;
    duplicates: number;
  };
  organizations: {
    required: boolean;
    roles: string[];
    sheet: string;
    created: number;
    updated: number;
    unchanged: number;
    skipped: number;
  };
  usersCountBefore: number;
  usersCountAfter: number;
  objectsCountBefore: number;
  objectsCountAfter: number;
  actsCountBefore: number;
  actsCountAfter: number;
  credentialsCountBefore: number;
  credentialsCountAfter: number;
}

async function audit(
  tx: { $executeRaw: PrismaClient['$executeRaw'] },
  catalog: string,
  counts: { created: number; updated: number; unchanged: number; duplicates: number },
  sheetName: string | null,
): Promise<void> {
  await insertAuditLogRow(tx, {
    actorUserId: null,
    actorName: 'directories-import',
    action: 'REFERENCE_DIRECTORIES_IMPORTED',
    entityType: catalog,
    entityId: randomUUID(),
    parentEntityType: null,
    parentEntityId: null,
    oldValue: null,
    newValue: {
      catalog,
      created: counts.created,
      updated: counts.updated,
      unchanged: counts.unchanged,
      duplicates: counts.duplicates,
      sheetName,
      timestamp: new Date().toISOString(),
    },
    reason: null,
    source: 'SYSTEM',
    occurredAt: new Date(),
    ipAddress: null,
    requestId: null,
  });
}

export async function importReferenceDirectories(options: {
  prisma: PrismaClient;
  sheets: DirectoriesWorkbookSheets;
  apply: boolean;
}): Promise<DirectoriesImportReport> {
  const [usersCountBefore, objectsCountBefore, actsCountBefore, credentialsCountBefore] =
    await Promise.all([
      options.prisma.user.count(),
      options.prisma.propertyObject.count(),
      options.prisma.act.count(),
      options.prisma.userCredential.count(),
    ]);

  const existingDefects = await options.prisma.defectType.findMany({
    select: { id: true, code: true, name: true, sortOrder: true, active: true },
  });
  const existingWorkTypes = await options.prisma.workType.findMany({
    select: { id: true, code: true, name: true, sortOrder: true, active: true },
  });
  const existingOrgs = await options.prisma.organization.findMany({
    select: {
      id: true,
      officialName: true,
      unp: true,
      postalAddress: true,
      email: true,
      phone: true,
      contactPerson: true,
      active: true,
      roles: { select: { role: true } },
    },
  });

  const actRoles = parseActOrganizationRoles(options.sheets.actRows);
  const organizations = parseOrganizationsMatrix(options.sheets.organizationRows, actRoles);
  const workTypeValues = mergeWorkTypeSources(
    options.sheets.workTypeValues,
    parseOrganizationWorkTypeColumn(options.sheets.organizationRows),
  );
  const incomingWorkTypes: DirectoryCodedItem[] = workTypeValues.rows.map((row) => ({
    sortOrder: row.sortOrder,
    name: row.name,
    code: workTypeCodeForName(row.name, row.sortOrder),
  }));
  const defectPlan = planApprovedDefectTypesSync(existingDefects);
  const workPlan = planCodedDirectorySync(existingWorkTypes, incomingWorkTypes);
  const orgPlan = planOrganizationSync(
    existingOrgs.map((row) => ({
      ...row,
      roles: row.roles.map((item) => item.role),
    })),
    organizations.items,
  );

  const report: DirectoriesImportReport = {
    applied: false,
    defectTypes: {
      source: APPROVED_DEFECT_TYPES_SOURCE,
      approvedCount: defectPlan.approvedCount,
      created: defectPlan.create,
      updated: defectPlan.update,
      unchanged: defectPlan.unchanged,
      active: existingDefects.filter((row) => row.active).length,
      duplicates: defectPlan.duplicates,
      unexpected: defectPlan.unexpected.length,
      exactOrder: defectPlan.exactOrder,
    },
    workTypes: {
      sheet: workTypeValues.sheet,
      sourceRows: workTypeValues.nonemptyRows,
      created: workPlan.create,
      updated: workPlan.update,
      unchanged: workPlan.unchanged,
      duplicates: workTypeValues.exactDuplicates,
    },
    organizations: {
      required: true,
      roles: organizations.organizationRoles,
      sheet: organizations.sheet || ORGANIZATIONS_SHEET_NAME,
      created: orgPlan.create,
      updated: orgPlan.update,
      unchanged: orgPlan.unchanged,
      skipped: organizations.skipped.length,
    },
    usersCountBefore,
    usersCountAfter: usersCountBefore,
    objectsCountBefore,
    objectsCountAfter: objectsCountBefore,
    actsCountBefore,
    actsCountAfter: actsCountBefore,
    credentialsCountBefore,
    credentialsCountAfter: credentialsCountBefore,
  };

  if (!options.apply) {
    return report;
  }

  await options.prisma.$transaction(async (tx) => {
    for (const item of defectPlan.items) {
      if (item.action === 'create') {
        await tx.defectType.create({
          data: {
            code: item.code,
            name: item.name,
            sortOrder: item.sortOrder,
            active: true,
          },
        });
      } else if (item.action === 'update' && item.existingId) {
        await tx.defectType.update({
          where: { id: item.existingId },
          data: { name: item.name, sortOrder: item.sortOrder, active: true },
        });
      }
    }
    for (const item of workPlan.items) {
      if (item.action === 'create') {
        await tx.workType.create({
          data: {
            code: item.code,
            name: item.name,
            sortOrder: item.sortOrder,
            active: true,
          },
        });
      } else if (item.action === 'update' && item.existingId) {
        await tx.workType.update({
          where: { id: item.existingId },
          data: { name: item.name, sortOrder: item.sortOrder, active: true },
        });
      }
    }
    for (const item of orgPlan.items) {
      if (item.action === 'create') {
        const created = await tx.organization.create({
          data: {
            officialName: item.row.officialName,
            unp: item.row.unp,
            postalAddress: item.row.postalAddress,
            email: item.row.email,
            phone: item.row.phone,
            contactPerson: item.row.contactPerson,
            active: item.row.active,
            roles: { create: item.row.roles.map((role) => ({ role })) },
          },
        });
        void created;
      } else if (item.action === 'update' && item.existingId) {
        await tx.organization.update({
          where: { id: item.existingId },
          data: {
            officialName: item.row.officialName,
            unp: item.row.unp,
            postalAddress: item.row.postalAddress,
            email: item.row.email,
            phone: item.row.phone,
            contactPerson: item.row.contactPerson,
            active: item.row.active,
          },
        });
        await tx.organizationRoleAssignment.deleteMany({
          where: { organizationId: item.existingId },
        });
        if (item.row.roles.length > 0) {
          await tx.organizationRoleAssignment.createMany({
            data: item.row.roles.map((role) => ({
              organizationId: item.existingId as string,
              role,
            })),
          });
        }
      }
    }
    await audit(
      tx,
      'DEFECT_TYPE',
      {
        created: defectPlan.create,
        updated: defectPlan.update,
        unchanged: defectPlan.unchanged,
        duplicates: defectPlan.duplicates,
      },
      APPROVED_DEFECT_TYPES_SOURCE,
    );
    await audit(
      tx,
      'WORK_TYPE',
      {
        created: workPlan.create,
        updated: workPlan.update,
        unchanged: workPlan.unchanged,
        duplicates: workPlan.duplicates,
      },
      workTypeValues.sheet,
    );
    await audit(
      tx,
      'ORGANIZATION',
      {
        created: orgPlan.create,
        updated: orgPlan.update,
        unchanged: orgPlan.unchanged,
        duplicates: orgPlan.duplicates,
      },
      ORGANIZATIONS_SHEET_NAME,
    );
  });

  const [usersCountAfter, objectsCountAfter, actsCountAfter, credentialsCountAfter, activeDefects] =
    await Promise.all([
      options.prisma.user.count(),
      options.prisma.propertyObject.count(),
      options.prisma.act.count(),
      options.prisma.userCredential.count(),
      options.prisma.defectType.count({ where: { active: true } }),
    ]);

  return {
    ...report,
    applied: true,
    defectTypes: {
      ...report.defectTypes,
      active: activeDefects,
    },
    usersCountAfter,
    objectsCountAfter,
    actsCountAfter,
    credentialsCountAfter,
  };
}

export { WORK_TYPES_SHEET_NAME };
