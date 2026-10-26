import { createOwnerPrismaClient } from '../src/index';

function databaseNameOf(value: string): string {
  try {
    return new URL(value).pathname.replace(/^\//, '').split('?')[0] ?? '';
  } catch {
    return '';
  }
}

async function removeFixture(
  prisma: ReturnType<typeof createOwnerPrismaClient>,
  actId: string,
): Promise<void> {
  const act = await prisma.act.findUnique({
    where: { id: actId },
    select: {
      importBatchId: true,
      objectId: true,
      customerOrganizationId: true,
      defectItems: { select: { id: true, defectTypeId: true } },
    },
  });
  if (!act) {
    return;
  }
  const defectIds = act.defectItems.map((item) => item.id);
  await prisma.attachment.deleteMany({ where: { actId } });
  const events = await prisma.notificationEvent.findMany({
    where: { OR: [{ actId }, { defectItemId: { in: defectIds } }] },
    select: { id: true },
  });
  const eventIds = events.map((event) => event.id);
  if (eventIds.length > 0) {
    const recipients = await prisma.notificationRecipient.findMany({
      where: { notificationEventId: { in: eventIds } },
      select: { id: true },
    });
    const recipientIds = recipients.map((recipient) => recipient.id);
    if (recipientIds.length > 0) {
      await prisma.emailDelivery.deleteMany({
        where: { notificationRecipientId: { in: recipientIds } },
      });
      await prisma.notificationRecipient.deleteMany({ where: { id: { in: recipientIds } } });
    }
    await prisma.notificationEvent.deleteMany({ where: { id: { in: eventIds } } });
  }
  await prisma.actChatMessage.deleteMany({ where: { actId } });
  if (defectIds.length > 0) {
    await prisma.defectItem.deleteMany({ where: { id: { in: defectIds } } });
  }
  await prisma.act.delete({ where: { id: actId } });
  if (act.importBatchId) {
    await prisma.importBatch.delete({ where: { id: act.importBatchId } });
  }
  if (act.objectId) {
    await prisma.propertyObject.delete({ where: { id: act.objectId } });
  }
  const defectTypeIds = act.defectItems.flatMap((item) =>
    item.defectTypeId ? [item.defectTypeId] : [],
  );
  if (defectTypeIds.length > 0) {
    await prisma.defectType.deleteMany({ where: { id: { in: defectTypeIds } } });
  }
  if (act.customerOrganizationId) {
    await prisma.organizationRoleAssignment.deleteMany({
      where: { organizationId: act.customerOrganizationId },
    });
    await prisma.organization.delete({ where: { id: act.customerOrganizationId } });
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  if (databaseNameOf(databaseUrl) !== 'sgr_registry_e2e') {
    throw new Error('fixture refused');
  }
  const prisma = createOwnerPrismaClient(databaseUrl);
  const deleteActId = process.env.FIXTURE_DELETE_ACT_ID;
  if (deleteActId) {
    try {
      await removeFixture(prisma, deleteActId);
    } finally {
      await prisma.$disconnect();
    }
    return;
  }
  try {
    const admin = await prisma.user.findFirst({
      where: { email: 'alexey.viktorov@example.sgr.local', status: 'ACTIVE' },
    });
    if (!admin) {
      throw new Error('admin missing');
    }
    const stamp = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
    const provenance = `https://bitrix.bir.by/docs/e2e-${stamp}`;
    const object = await prisma.propertyObject.create({
      data: { name: '7.1', address: `e2e-${stamp}` },
    });
    const customer = await prisma.organization.create({
      data: {
        officialName: `Заказчик e2e ${stamp}`,
        postalAddress: 'Минск',
        email: `cust-${stamp}@example.sgr.local`,
        phone: '1',
        contactPerson: 'К',
        roles: { create: [{ role: 'CUSTOMER' }] },
      },
    });
    const defectType = await prisma.defectType.create({
      data: { code: `E2E-${stamp}`, name: `Дефект ${stamp}`, sortOrder: 80 },
    });
    const batch = await prisma.importBatch.create({
      data: {
        sourceSystem: 'LEGACY_DEFECT_ACT_REGISTRY',
        sourceFileName: `e2e-${stamp}.xlsx`,
        sourceFileSha256: stamp.padEnd(64, 'b').slice(0, 64),
        sourceSheet: 'Реестр',
        environment: 'e2e',
        databaseName: 'sgr_registry_e2e',
        status: 'COMPLETED',
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });
    const act = await prisma.act.create({
      data: {
        formCode: 'S23',
        year: 2024,
        sequence: 1_500_000 + Math.floor(Math.random() * 100_000),
        officialNumber: null,
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: new Date('2024-04-12T12:00:00.000Z'),
        status: 'IMPORTED_UNSPECIFIED',
        signedDocumentRef: provenance,
        sourceSystem: 'LEGACY_DEFECT_ACT_REGISTRY',
        sourceExternalUrl: provenance,
        sourceImportKey: `LEGACY_DEFECT_ACT_REGISTRY:${provenance}`,
        sourceActNumberRaw: '1',
        importBatchId: batch.id,
        importedAt: new Date(),
        createdById: admin.id,
        defectItems: {
          create: {
            location: `Помещение ${stamp}`,
            claimDetails: 'Течь',
            defectTypeId: defectType.id,
            status: 'IN_PROGRESS',
          },
        },
      },
    });
    process.stdout.write(`${act.id}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'fixture failed';
  console.error(message);
  process.exit(1);
});
