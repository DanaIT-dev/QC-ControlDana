import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPROVED_DEFECT_TYPES_V1,
  CONFIRMED_LAST_FIRST_TOKEN_ORDER,
  personNameWriteFields,
} from '@sgr-registry/domain';
import { createOwnerPrismaClient } from '../../src/client';
import { createPropertyObjectViaDefiner } from '../../src/create-property-object';
import { importReferenceDirectories } from '../../src/directories-import';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
assertSafeTestDatabaseUrl(databaseUrl);
const prisma = createOwnerPrismaClient(databaseUrl);
const MARKER = `dirimp-${randomUUID().slice(0, 8)}`;

describe('reference directories importer', () => {
  const createdWorkTypeIds: string[] = [];
  const createdOrgIds: string[] = [];
  const createdObjectIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    if (createdObjectIds.length > 0) {
      await prisma.propertyObjectEngineer.deleteMany({
        where: { propertyObjectId: { in: createdObjectIds } },
      });
      await prisma.propertyObject.deleteMany({ where: { id: { in: createdObjectIds } } });
    }
    if (createdOrgIds.length > 0) {
      await prisma.organizationRoleAssignment.deleteMany({
        where: { organizationId: { in: createdOrgIds } },
      });
      await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
    if (createdWorkTypeIds.length > 0) {
      await prisma.organizationWorkType.deleteMany({
        where: { workTypeId: { in: createdWorkTypeIds } },
      });
      await prisma.workType.deleteMany({ where: { id: { in: createdWorkTypeIds } } });
    }
    if (createdUserIds.length > 0 || createdObjectIds.length > 0) {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only',
      );
      try {
        await prisma.auditLog.deleteMany({
          where: {
            OR: [
              ...(createdUserIds.length > 0 ? [{ actorUserId: { in: createdUserIds } }] : []),
              ...(createdObjectIds.length > 0 ? [{ entityId: { in: createdObjectIds } }] : []),
              { requestId: { startsWith: MARKER } },
            ],
          },
        });
      } finally {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only',
        );
      }
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  });

  it('dry-run does not write, apply is idempotent and does not create users', async () => {
    const usersBefore = await prisma.user.count();
    const objectsBefore = await prisma.propertyObject.count();
    const credentialsBefore = await prisma.userCredential.count();
    const customerName = `DIRTEST ${MARKER} заказчик`;
    const liableName = `DIRTEST ${MARKER} подрядчик`;
    const workTypeName = `DIRTEST ${MARKER} окна`;
    const sheets = {
      sheetNames: ['Виды работ', 'Организации', 'Реестр актов'],
      workTypeValues: ['Виды работ', workTypeName, '', workTypeName],
      organizationRows: [
        [
          'Наименование организации',
          'Статус',
          'Вид выполняемых работ',
          'УНП/ИНН',
          'Почтовый адрес',
          'email',
          'Контактное лицо',
          'телефон',
        ],
        [customerName, 'Действующий', workTypeName, '', '', '', '', ''],
        [liableName, 'Действующий', workTypeName, '', 'ул. Тестовая, 1', '', '', ''],
        ['Собственник (Иванов И.И.)', 'Действующий', '—', '', '', '', '', ''],
      ],
      actRows: [
        ['Заказчик', 'Виновная организация'],
        [customerName, liableName],
      ],
    };

    const dryRun = await importReferenceDirectories({ prisma, sheets, apply: false });
    expect(dryRun.applied).toBe(false);
    expect(dryRun.defectTypes.approvedCount).toBe(22);
    expect(dryRun.workTypes.created).toBeGreaterThanOrEqual(1);
    expect(dryRun.organizations.created).toBe(2);
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.propertyObject.count()).toBe(objectsBefore);

    const applied = await importReferenceDirectories({ prisma, sheets, apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.usersCountAfter).toBe(usersBefore);
    expect(applied.objectsCountAfter).toBe(objectsBefore);
    expect(applied.credentialsCountAfter).toBe(credentialsBefore);
    const createdWork = await prisma.workType.findFirst({ where: { name: workTypeName } });
    const createdCustomer = await prisma.organization.findFirst({
      where: { officialName: customerName },
    });
    const createdLiable = await prisma.organization.findFirst({
      where: { officialName: liableName },
    });
    expect(createdWork).toBeTruthy();
    expect(createdCustomer).toBeTruthy();
    expect(createdLiable).toBeTruthy();
    if (createdWork) {
      createdWorkTypeIds.push(createdWork.id);
    }
    if (createdCustomer) {
      createdOrgIds.push(createdCustomer.id);
    }
    if (createdLiable) {
      createdOrgIds.push(createdLiable.id);
    }

    const defects = await prisma.defectType.findMany({
      where: { name: { in: APPROVED_DEFECT_TYPES_V1.map((item) => item.name) } },
      orderBy: { sortOrder: 'asc' },
    });
    expect(defects).toHaveLength(22);
    expect(defects.every((row) => row.active)).toBe(true);
    expect(defects.map((row) => row.name)).toEqual(
      APPROVED_DEFECT_TYPES_V1.map((item) => item.name),
    );

    const repeat = await importReferenceDirectories({ prisma, sheets, apply: true });
    expect(repeat.workTypes.created).toBe(0);
    expect(repeat.organizations.created).toBe(0);
    expect(repeat.defectTypes.created).toBe(0);
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.userCredential.count()).toBe(credentialsBefore);
  });

  it('creates a manual object in one transaction and rolls back when audit cannot be written', async () => {
    const actor = await prisma.user.create({
      data: {
        ...personNameWriteFields(`${MARKER} admin`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
        email: `${MARKER}.admin@example.sgr.local`,
        role: 'ADMIN',
        status: 'ACTIVE',
        mustChangePassword: false,
      },
    });
    createdUserIds.push(actor.id);
    const name = `${MARKER} object`;
    const created = await prisma.$transaction((tx) =>
      createPropertyObjectViaDefiner(tx, {
        name,
        address: 'ул. Ручная, 1',
        commissionedAt: null,
        warrantyEndsAt: null,
        responsibleEngineerId: null,
        responsibleEngineerName: 'Василевич М.В.',
        actorUserId: actor.id,
        actorName: actor.fullName,
        requestId: `${MARKER}-ok`,
      }),
    );
    createdObjectIds.push(created.id);
    expect(created.sourceResponsibleEngineerName).toBe('Василевич М.В.');
    expect(
      await prisma.propertyObjectEngineer.count({ where: { propertyObjectId: created.id } }),
    ).toBe(0);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'PROPERTY_OBJECT_CREATED', entityId: created.id },
    });
    expect(audit).toBeTruthy();

    const missingActor = randomUUID();
    const failedName = `${MARKER} rolled-back`;
    await expect(
      prisma.$transaction((tx) =>
        createPropertyObjectViaDefiner(tx, {
          name: failedName,
          address: null,
          commissionedAt: null,
          warrantyEndsAt: null,
          responsibleEngineerId: null,
          responsibleEngineerName: null,
          actorUserId: missingActor,
          actorName: 'missing',
          requestId: `${MARKER}-fail`,
        }),
      ),
    ).rejects.toThrow();
    expect(await prisma.propertyObject.findFirst({ where: { name: failedName } })).toBeNull();
  });
});
