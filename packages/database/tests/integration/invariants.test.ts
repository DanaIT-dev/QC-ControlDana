import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allocateActNumber } from '../../src/act-number';
import { createPrismaClient } from '../../src/client';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';

const databaseUrl = process.env.DATABASE_URL ?? '';
assertSafeTestDatabaseUrl(databaseUrl);

const prisma = createPrismaClient(databaseUrl);

async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "audit_logs"');
  await prisma.proposal.deleteMany();
  await prisma.defectItemLiableOrganization.deleteMany();
  await prisma.defectItemEngineer.deleteMany();
  await prisma.defectItem.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.act.deleteMany();
  await prisma.actNumberSequence.deleteMany();
  await prisma.organizationWorkType.deleteMany();
  await prisma.organizationRoleAssignment.deleteMany();
  await prisma.propertyObjectEngineer.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.propertyObject.deleteMany();
  await prisma.user.deleteMany();
  await prisma.defectType.deleteMany();
  await prisma.workType.deleteMany();
  await prisma.systemSettings.deleteMany();
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('database invariants', () => {
  it('allows several empty UNP values and rejects a duplicate normalized UNP', async () => {
    const firstEmpty = await prisma.organization.create({
      data: {
        officialName: 'Org empty A',
        unp: null,
        postalAddress: 'addr',
        email: 'empty-a@example.sgr.local',
        phone: '1',
        contactPerson: 'A',
      },
    });
    const secondEmpty = await prisma.organization.create({
      data: {
        officialName: 'Org empty B',
        unp: null,
        postalAddress: 'addr',
        email: 'empty-b@example.sgr.local',
        phone: '1',
        contactPerson: 'B',
      },
    });
    expect(firstEmpty.unp).toBeNull();
    expect(secondEmpty.unp).toBeNull();

    await prisma.organization.create({
      data: {
        officialName: 'Org with UNP',
        unp: '100000099',
        postalAddress: 'addr',
        email: 'unp@example.sgr.local',
        phone: '1',
        contactPerson: 'C',
      },
    });

    await expect(
      prisma.organization.create({
        data: {
          officialName: 'Org with same UNP',
          unp: '100000099',
          postalAddress: 'addr',
          email: 'unp-dup@example.sgr.local',
          phone: '1',
          contactPerson: 'D',
        },
      }),
    ).rejects.toBeTruthy();
  });

  it('allocates unique act numbers from a sequence table under concurrency', async () => {
    const object = await prisma.propertyObject.create({
      data: { name: 'Object A', address: 'addr' },
    });
    const customer = await prisma.organization.create({
      data: {
        officialName: 'Customer A',
        unp: '200000001',
        postalAddress: 'addr',
        email: 'cust-a@example.sgr.local',
        phone: '1',
        contactPerson: 'C',
      },
    });

    const issuedAt = new Date('2026-08-26T12:00:00.000Z');
    const [first, second] = await Promise.all([
      prisma.$transaction((tx) => allocateActNumber(tx, 'S1', issuedAt)),
      prisma.$transaction((tx) => allocateActNumber(tx, 'S1', issuedAt)),
    ]);

    expect(new Set([first.officialNumber, second.officialNumber]).size).toBe(2);
    expect([first.sequence, second.sequence].sort()).toEqual([1, 2]);
    expect(first.officialNumber.startsWith('С-1-2026-')).toBe(true);

    await prisma.act.create({
      data: {
        officialNumber: first.officialNumber,
        formCode: first.formCode,
        year: first.year,
        sequence: first.sequence,
        objectId: object.id,
        customerOrganizationId: customer.id,
        status: 'IN_PROGRESS',
      },
    });

    await expect(
      prisma.act.update({
        where: { officialNumber: first.officialNumber },
        data: { officialNumber: 'С-1-2026-999999' },
      }),
    ).rejects.toThrow(/cannot be changed/i);
  });

  it('keeps proposal slots unique and allows multiple engineers and liable organizations', async () => {
    const object = await prisma.propertyObject.create({
      data: { name: 'Object B', address: 'addr' },
    });
    const customer = await prisma.organization.create({
      data: {
        officialName: 'Customer B',
        unp: '200000002',
        postalAddress: 'addr',
        email: 'cust-b@example.sgr.local',
        phone: '1',
        contactPerson: 'C',
      },
    });
    const liableA = await prisma.organization.create({
      data: {
        officialName: 'Liable A',
        unp: '200000003',
        postalAddress: 'addr',
        email: 'liable-a@example.sgr.local',
        phone: '1',
        contactPerson: 'L',
      },
    });
    const liableB = await prisma.organization.create({
      data: {
        officialName: 'Liable B',
        unp: '200000004',
        postalAddress: 'addr',
        email: 'liable-b@example.sgr.local',
        phone: '1',
        contactPerson: 'L',
      },
    });
    const alt = await prisma.organization.create({
      data: {
        officialName: 'Alt A',
        unp: '200000005',
        postalAddress: 'addr',
        email: 'alt-int@example.sgr.local',
        phone: '1',
        contactPerson: 'A',
      },
    });
    const engineerA = await prisma.user.create({
      data: {
        fullName: 'Инженер А',
        email: `eng-a-${randomUUID()}@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
      },
    });
    const engineerB = await prisma.user.create({
      data: {
        fullName: 'Инженер Б',
        email: `eng-b-${randomUUID()}@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
      },
    });
    const defectType = await prisma.defectType.create({
      data: { code: `INT-${randomUUID().slice(0, 8)}`, name: 'Integration type', sortOrder: 99 },
    });
    const number = await allocateActNumber(prisma, 'S23', new Date('2026-08-26T12:00:00.000Z'));
    const act = await prisma.act.create({
      data: {
        officialNumber: number.officialNumber,
        formCode: number.formCode,
        year: number.year,
        sequence: number.sequence,
        objectId: object.id,
        customerOrganizationId: customer.id,
        status: 'IN_PROGRESS',
      },
    });
    const item = await prisma.defectItem.create({
      data: {
        actId: act.id,
        location: 'Квартира 1',
        defectTypeId: defectType.id,
        claimDetails: 'Demo',
      },
    });

    await prisma.defectItemEngineer.createMany({
      data: [
        { defectItemId: item.id, userId: engineerA.id },
        { defectItemId: item.id, userId: engineerB.id },
      ],
    });
    await prisma.defectItemLiableOrganization.createMany({
      data: [
        { defectItemId: item.id, organizationId: liableA.id },
        { defectItemId: item.id, organizationId: liableB.id },
      ],
    });

    const engineers = await prisma.defectItemEngineer.findMany({
      where: { defectItemId: item.id },
    });
    const liable = await prisma.defectItemLiableOrganization.findMany({
      where: { defectItemId: item.id },
    });
    expect(engineers).toHaveLength(2);
    expect(liable).toHaveLength(2);

    await prisma.proposal.create({
      data: {
        defectItemId: item.id,
        slot: 'A',
        alternativeContractorOrganizationId: alt.id,
        amount: new Prisma.Decimal('10.00'),
      },
    });
    await expect(
      prisma.proposal.create({
        data: {
          defectItemId: item.id,
          slot: 'A',
          alternativeContractorOrganizationId: alt.id,
          amount: new Prisma.Decimal('11.00'),
        },
      }),
    ).rejects.toBeTruthy();

    await prisma.user.update({
      where: { id: engineerA.id },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    const assignment = await prisma.defectItemEngineer.findUnique({
      where: { defectItemId_userId: { defectItemId: item.id, userId: engineerA.id } },
    });
    expect(assignment).not.toBeNull();
  });

  it('rejects physical Act deletion and does not cascade-delete AuditLog', async () => {
    const object = await prisma.propertyObject.create({
      data: { name: 'Object C', address: 'addr' },
    });
    const customer = await prisma.organization.create({
      data: {
        officialName: 'Customer C',
        unp: '200000006',
        postalAddress: 'addr',
        email: 'cust-c@example.sgr.local',
        phone: '1',
        contactPerson: 'C',
      },
    });
    const actor = await prisma.user.create({
      data: {
        fullName: 'Аудитор Демо',
        email: `audit-${randomUUID()}@example.sgr.local`,
        role: 'ADMIN',
      },
    });
    const defectType = await prisma.defectType.create({
      data: { code: `DEL-${randomUUID().slice(0, 8)}`, name: 'Delete guard type', sortOrder: 100 },
    });
    const number = await allocateActNumber(prisma, 'S1', new Date('2026-08-26T12:00:00.000Z'));
    const act = await prisma.act.create({
      data: {
        officialNumber: number.officialNumber,
        formCode: number.formCode,
        year: number.year,
        sequence: number.sequence,
        objectId: object.id,
        customerOrganizationId: customer.id,
        status: 'IN_PROGRESS',
      },
    });
    await prisma.defectItem.create({
      data: {
        actId: act.id,
        location: 'Квартира 2',
        defectTypeId: defectType.id,
        claimDetails: 'Demo',
      },
    });

    await expect(prisma.act.delete({ where: { id: act.id } })).rejects.toBeTruthy();
    expect(await prisma.act.findUnique({ where: { id: act.id } })).not.toBeNull();

    const log = await prisma.auditLog.create({
      data: {
        actorUserId: actor.id,
        action: 'ACT_CREATED',
        entityType: 'Act',
        entityId: act.id,
      },
    });

    await expect(prisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow(/append-only/i);
    await expect(prisma.user.delete({ where: { id: actor.id } })).rejects.toBeTruthy();
    expect(await prisma.auditLog.findUnique({ where: { id: log.id } })).not.toBeNull();
  });
});
