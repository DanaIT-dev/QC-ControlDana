import { databaseNameOf } from '../src/database-url';
import { E2E_DATABASE_NAME } from '../src/e2e-target';
import { createOwnerPrismaClient } from '../src/index';

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? '';
const databaseName = databaseNameOf(databaseUrl);
if (databaseName !== E2E_DATABASE_NAME) {
  throw new Error(`analytics fixture refused database ${databaseName || 'unknown'}`);
}

const owner = createOwnerPrismaClient(databaseUrl);
const marker = 'e2e-analytics-ftr';

async function main(): Promise<void> {
  const admin = await owner.user.findUniqueOrThrow({
    where: { email: 'alexey.viktorov@example.sgr.local' },
    select: { id: true },
  });
  const ownOrg = await owner.organization.findFirstOrThrow({
    where: { officialName: 'ООО «Тепломонтаж Альфа» (демо)' },
    select: { id: true },
  });
  const foreignOrg = await owner.organization.findFirstOrThrow({
    where: { officialName: 'ООО «Оконные системы Бел» (демо)' },
    select: { id: true },
  });
  const object = await owner.propertyObject.findFirstOrThrow({ select: { id: true } });
  const customer = await owner.organization.findFirstOrThrow({
    where: { id: { notIn: [ownOrg.id, foreignOrg.id] } },
    select: { id: true },
  });
  const defectType = await owner.defectType.findFirstOrThrow({ select: { id: true } });
  const workType = await owner.workType.findFirstOrThrow({ select: { id: true } });

  await owner.analyticsInsightDefect.deleteMany();
  await owner.analyticsInsight.deleteMany();
  const previous = await owner.act.findMany({
    where: { officialNumber: marker },
    select: { id: true },
  });
  const previousIds = previous.map((act) => act.id);
  if (previousIds.length > 0) {
    await owner.defectItemLiableOrganization.deleteMany({
      where: { defectItem: { actId: { in: previousIds } } },
    });
    await owner.defectItem.deleteMany({ where: { actId: { in: previousIds } } });
    await owner.act.deleteMany({ where: { id: { in: previousIds } } });
  }

  const act = await owner.act.create({
    data: {
      formCode: 'S1',
      year: 2097,
      sequence: 900_001,
      objectId: object.id,
      customerOrganizationId: customer.id,
      issuedOn: new Date('2026-10-01T00:00:00.000Z'),
      status: 'IN_PROGRESS',
      startedAt: new Date('2026-10-01T00:00:00.000Z'),
      officialNumber: marker,
    },
  });

  async function completed(orgId: string, location: string, withAttempt: boolean) {
    const defect = await owner.defectItem.create({
      data: {
        actId: act.id,
        defectTypeId: defectType.id,
        workTypeId: workType.id,
        status: 'COMPLETED',
        location,
        claimDetails: location,
        readyAt: new Date('2026-10-04T00:00:00.000Z'),
        liableOrganizations: { create: { organizationId: orgId } },
      },
    });
    if (!withAttempt) {
      return;
    }
    const rejected = location.startsWith('rework');
    await owner.defectInspectionAttempt.create({
      data: {
        defectItemId: defect.id,
        attemptNumber: 1,
        status: rejected ? 'REJECTED' : 'ACCEPTED',
        submittedByUserId: admin.id,
        submittedAt: new Date('2026-10-02T00:00:00.000Z'),
        reviewedByUserId: admin.id,
        reviewedAt: new Date('2026-10-03T00:00:00.000Z'),
        rejectionReason: rejected ? 'повтор' : null,
      },
    });
    if (rejected) {
      await owner.defectInspectionAttempt.create({
        data: {
          defectItemId: defect.id,
          attemptNumber: 2,
          status: 'ACCEPTED',
          submittedByUserId: admin.id,
          submittedAt: new Date('2026-10-03T00:00:00.000Z'),
          reviewedByUserId: admin.id,
          reviewedAt: new Date('2026-10-04T00:00:00.000Z'),
        },
      });
    }
  }

  for (let index = 0; index < 20; index += 1) {
    await completed(foreignOrg.id, `baseline-${index}`, true);
  }
  for (let index = 0; index < 6; index += 1) {
    await completed(ownOrg.id, `rework-${index}`, true);
  }
  await completed(ownOrg.id, 'legacy-without-attempt', false);
  console.log(JSON.stringify({ seeded: true, actId: act.id, support: 6 }));
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'analytics fixture failed';
    console.error(message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await owner.$disconnect();
  });
