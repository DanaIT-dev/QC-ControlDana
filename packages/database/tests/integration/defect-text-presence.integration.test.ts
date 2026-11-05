import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createOwnerPrismaClient } from '../../src/client';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
assertSafeTestDatabaseUrl(databaseUrl);
const prisma = createOwnerPrismaClient(databaseUrl);

describe('defect text presence', () => {
  const actIds: string[] = [];
  const objectIds: string[] = [];

  afterAll(async () => {
    if (actIds.length > 0) {
      await prisma.defectItem.deleteMany({ where: { actId: { in: actIds } } });
      await prisma.act.deleteMany({ where: { id: { in: actIds } } });
    }
    if (objectIds.length > 0) {
      await prisma.propertyObject.deleteMany({ where: { id: { in: objectIds } } });
    }
    await prisma.$disconnect();
  });

  it('clears location and description on update and still requires both when inserting into a started act', async () => {
    const object = await prisma.propertyObject.create({
      data: { name: `Текст ${randomUUID().slice(0, 8)}`, address: 'Минск' },
    });
    objectIds.push(object.id);
    const createdAt = new Date();
    const act = await prisma.act.create({
      data: {
        objectId: object.id,
        officialNumber: `С-1-тест-${randomUUID().slice(0, 8)}`,
        status: 'IN_PROGRESS',
        createdAt,
        startedAt: new Date(createdAt.getTime() + 1000),
      },
    });
    actIds.push(act.id);
    const item = await prisma.defectItem.create({
      data: { actId: act.id, location: 'Кухня', claimDetails: 'Трещина', status: 'IN_PROGRESS' },
    });
    const cleared = await prisma.defectItem.update({
      where: { id: item.id },
      data: { location: null, claimDetails: null },
    });
    expect(cleared.location).toBeNull();
    expect(cleared.claimDetails).toBeNull();
    await expect(
      prisma.defectItem.create({
        data: { actId: act.id, location: '   ', claimDetails: null, status: 'IN_PROGRESS' },
      }),
    ).rejects.toThrow(/defect text is required/);
  });
});
