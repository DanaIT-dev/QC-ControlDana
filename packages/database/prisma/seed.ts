import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { Prisma } from '@prisma/client';
import {
  allocateActNumber,
  computeActStatus,
  createPrismaClient,
  normalizeUnp,
} from '../src/index';

const repoRoot = resolve(__dirname, '../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile });

const DEFECT_TYPES = [
  { code: 'SEWER', name: 'Дефекты канализации', sortOrder: 1 },
  { code: 'MASONRY', name: 'Дефекты кладки', sortOrder: 2 },
  { code: 'FLOORING', name: 'Дефекты напольного покрытия', sortOrder: 3 },
  { code: 'WINDOWS', name: 'Дефекты оконных изделий', sortOrder: 4 },
  { code: 'FINISHING', name: 'Дефекты отделки', sortOrder: 5 },
  { code: 'PORCH_FINISHING', name: 'Дефекты отделки крылец', sortOrder: 6 },
  { code: 'LOGGIA_FINISHING', name: 'Дефекты отделки лоджии', sortOrder: 7 },
  { code: 'SILLS', name: 'Дефекты отливов', sortOrder: 8 },
  { code: 'RADIATORS', name: 'Дефекты радиаторов отопления', sortOrder: 9 },
  { code: 'HEATING_SYSTEM', name: 'Дефекты системы отопления', sortOrder: 10 },
  { code: 'GLAZING', name: 'Дефекты стеклопакетов', sortOrder: 11 },
  { code: 'GLAZING_INSIDE', name: 'Дефекты стеклопакетов — замена изнутри', sortOrder: 12 },
  { code: 'GLAZING_OUTSIDE', name: 'Дефекты стеклопакетов — замена снаружи', sortOrder: 13 },
  { code: 'WALLS', name: 'Дефекты стен', sortOrder: 14 },
  { code: 'FACADE', name: 'Дефекты фасада', sortOrder: 15 },
  { code: 'ELECTRICAL', name: 'Дефекты электромонтажных работ', sortOrder: 16 },
  { code: 'LEAKAGE', name: 'Замокание/течь', sortOrder: 17 },
  { code: 'DRAFT_FREEZE', name: 'Продувы/промерзания', sortOrder: 18 },
] as const;

const WORK_TYPES = [
  { code: 'GENERAL_CONTRACTING', name: 'Генподрядные работы', sortOrder: 1 },
  { code: 'HEATING', name: 'Отопление', sortOrder: 2 },
  { code: 'VENTILATION', name: 'Вентиляция', sortOrder: 3 },
  { code: 'WATER_SUPPLY', name: 'Водоснабжение', sortOrder: 4 },
  { code: 'SEWERAGE', name: 'Канализация', sortOrder: 5 },
  { code: 'ELEVATORS', name: 'Лифты', sortOrder: 6 },
  { code: 'ROOF', name: 'Кровля', sortOrder: 7 },
  { code: 'FACADE', name: 'Фасад', sortOrder: 8 },
  { code: 'WINDOWS_STAINED_GLASS', name: 'Окна и витражи', sortOrder: 9 },
  { code: 'MASONRY', name: 'Кладка', sortOrder: 10 },
  { code: 'SMOKE_PROTECTION', name: 'Противодымная защита', sortOrder: 11 },
  { code: 'COMMUNICATIONS', name: 'Сети связи', sortOrder: 12 },
  { code: 'VIDEO_SURVEILLANCE', name: 'Видеонаблюдение', sortOrder: 13 },
  { code: 'AUTOMATION', name: 'Автоматика', sortOrder: 14 },
  { code: 'SCREED', name: 'Стяжка', sortOrder: 15 },
] as const;

async function seed(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to seed the database');
  }

  const prisma = createPrismaClient(databaseUrl);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.systemSettings.upsert({
        where: { id: 'default' },
        update: { deadlineWarningDays: 3 },
        create: { id: 'default', deadlineWarningDays: 3 },
      });

      for (const item of DEFECT_TYPES) {
        await tx.defectType.upsert({
          where: { code: item.code },
          update: { name: item.name, sortOrder: item.sortOrder, active: true },
          create: item,
        });
      }

      for (const item of WORK_TYPES) {
        await tx.workType.upsert({
          where: { code: item.code },
          update: { name: item.name, sortOrder: item.sortOrder, active: true },
          create: item,
        });
      }

      await tx.user.upsert({
        where: { email: 'alexey.viktorov@example.sgr.local' },
        update: {},
        create: {
          fullName: 'Алексей Викторов',
          email: 'alexey.viktorov@example.sgr.local',
          phone: '+375290000001',
          role: 'ADMIN',
        },
      });

      await tx.user.upsert({
        where: { email: 'marina.sokolova@example.sgr.local' },
        update: {},
        create: {
          fullName: 'Марина Соколова',
          email: 'marina.sokolova@example.sgr.local',
          phone: '+375290000002',
          role: 'SGR_MANAGER',
        },
      });

      const engineerNorth = await tx.user.upsert({
        where: { email: 'dmitry.orlov@example.sgr.local' },
        update: {},
        create: {
          fullName: 'Дмитрий Орлов',
          email: 'dmitry.orlov@example.sgr.local',
          phone: '+375290000003',
          role: 'RESPONSIBLE_ENGINEER',
        },
      });

      const engineerRiver = await tx.user.upsert({
        where: { email: 'elena.krylova@example.sgr.local' },
        update: {},
        create: {
          fullName: 'Елена Крылова',
          email: 'elena.krylova@example.sgr.local',
          phone: '+375290000004',
          role: 'RESPONSIBLE_ENGINEER',
        },
      });

      await tx.user.upsert({
        where: { email: 'igor.panteleev@example.sgr.local' },
        update: {},
        create: {
          fullName: 'Игорь Пантелеев',
          email: 'igor.panteleev@example.sgr.local',
          phone: '+375290000005',
          role: 'CONTRACTOR_ENGINEER',
        },
      });

      const northPark = await tx.propertyObject.upsert({
        where: { id: '11111111-1111-4111-8111-111111111111' },
        update: {},
        create: {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'ЖК «Северный парк» (демо)',
          address: 'г. Минск, ул. Вымышленная, 1',
          commissionedAt: new Date('2024-06-01T00:00:00.000Z'),
          warrantyEndsAt: new Date('2029-06-01T00:00:00.000Z'),
        },
      });

      const riverQuarter = await tx.propertyObject.upsert({
        where: { id: '22222222-2222-4222-8222-222222222222' },
        update: {},
        create: {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'ЖК «Речной квартал» (демо)',
          address: 'г. Минск, пр. Демонстрационный, 15',
          commissionedAt: new Date('2025-03-15T00:00:00.000Z'),
          warrantyEndsAt: new Date('2030-03-15T00:00:00.000Z'),
        },
      });

      const existingNorthAssignment = await tx.propertyObjectEngineer.findFirst({
        where: { propertyObjectId: northPark.id, userId: engineerNorth.id, unassignedAt: null },
      });
      if (!existingNorthAssignment) {
        await tx.propertyObjectEngineer.create({
          data: { propertyObjectId: northPark.id, userId: engineerNorth.id },
        });
      }

      const existingRiverAssignment = await tx.propertyObjectEngineer.findFirst({
        where: { propertyObjectId: riverQuarter.id, userId: engineerRiver.id, unassignedAt: null },
      });
      if (!existingRiverAssignment) {
        await tx.propertyObjectEngineer.create({
          data: { propertyObjectId: riverQuarter.id, userId: engineerRiver.id },
        });
      }

      const customer = await upsertOrganization(tx, {
        officialName: 'ОАО «Северная инвестиционная группа» (демо)',
        unp: '100000001',
        postalAddress: 'г. Минск, ул. Заказная, 10',
        email: 'customer@example.sgr.local',
        phone: '+375170000001',
        contactPerson: 'Павел Немцов',
        roles: ['CUSTOMER'],
        workTypeCodes: ['GENERAL_CONTRACTING'],
      });

      const liableHeating = await upsertOrganization(tx, {
        officialName: 'ООО «Тепломонтаж Альфа» (демо)',
        unp: '100000002',
        postalAddress: 'г. Минск, ул. Котельная, 8',
        email: 'heating@example.sgr.local',
        phone: '+375170000002',
        contactPerson: 'Сергей Лавров',
        roles: ['LIABLE_CONTRACTOR'],
        workTypeCodes: ['HEATING'],
      });

      const liableWindows = await upsertOrganization(tx, {
        officialName: 'ООО «Оконные системы Бел» (демо)',
        unp: '100000003',
        postalAddress: 'г. Минск, ул. Рамная, 4',
        email: 'windows@example.sgr.local',
        phone: '+375170000003',
        contactPerson: 'Ольга Ветрова',
        roles: ['LIABLE_CONTRACTOR'],
        workTypeCodes: ['WINDOWS_STAINED_GLASS'],
      });

      const altA = await upsertOrganization(tx, {
        officialName: 'ООО «Альтернатива А» (демо)',
        unp: '100000004',
        postalAddress: 'г. Минск, ул. Подрядная, 21',
        email: 'alt-a@example.sgr.local',
        phone: '+375170000004',
        contactPerson: 'Никита Белов',
        roles: ['ALTERNATIVE_CONTRACTOR'],
        workTypeCodes: ['HEATING', 'WINDOWS_STAINED_GLASS'],
      });

      const altB = await upsertOrganization(tx, {
        officialName: 'ООО «Альтернатива Б» (демо)',
        unp: null,
        postalAddress: 'г. Минск, ул. Сметная, 5',
        email: 'alt-b@example.sgr.local',
        phone: '+375170000005',
        contactPerson: 'Татьяна Рогова',
        roles: ['ALTERNATIVE_CONTRACTOR'],
        workTypeCodes: ['HEATING', 'FACADE'],
      });

      const altC = await upsertOrganization(tx, {
        officialName: 'ООО «Альтернатива В» (демо)',
        unp: '',
        postalAddress: 'г. Минск, ул. Конкурсная, 9',
        email: 'alt-c@example.sgr.local',
        phone: '+375170000006',
        contactPerson: 'Андрей Шилов',
        roles: ['ALTERNATIVE_CONTRACTOR'],
        workTypeCodes: ['GENERAL_CONTRACTING'],
      });

      const existingAct = await tx.act.findUnique({
        where: { officialNumber: 'С-1-2026-000001' },
      });

      if (!existingAct) {
        const issuedAt = new Date('2026-03-01T09:00:00.000Z');
        const number = await allocateActNumber(tx, 'S1', issuedAt);
        const leakage = await tx.defectType.findUniqueOrThrow({ where: { code: 'LEAKAGE' } });
        const windows = await tx.defectType.findUniqueOrThrow({ where: { code: 'WINDOWS' } });

        const firstItemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
        const secondItemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

        const act = await tx.act.create({
          data: {
            officialNumber: number.officialNumber,
            formCode: number.formCode,
            year: number.year,
            sequence: number.sequence,
            objectId: northPark.id,
            customerOrganizationId: customer.id,
            signedDocumentRef: null,
            status: 'IN_PROGRESS',
            createdAt: issuedAt,
          },
        });

        await tx.defectItem.create({
          data: {
            id: firstItemId,
            actId: act.id,
            location: 'Подъезд 2, квартира 45, санузел',
            defectTypeId: leakage.id,
            status: 'IN_PROGRESS',
            claimDetails: 'Течь стояка холодного водоснабжения на уровне перекрытия.',
            plannedDeadline: new Date('2026-03-20T00:00:00.000Z'),
            claimDeadline: new Date('2026-04-01T00:00:00.000Z'),
            notes: 'Демонстрационная строка дефекта',
          },
        });

        await tx.defectItem.create({
          data: {
            id: secondItemId,
            actId: act.id,
            location: 'Подъезд 1, квартира 12, гостиная',
            defectTypeId: windows.id,
            status: 'COMPLETED',
            claimDetails: 'Нарушение герметичности оконного блока.',
            plannedDeadline: new Date('2026-03-10T00:00:00.000Z'),
            readyAt: new Date('2026-03-08T15:30:00.000Z'),
          },
        });

        await tx.defectItemEngineer.createMany({
          data: [
            { defectItemId: firstItemId, userId: engineerNorth.id },
            { defectItemId: firstItemId, userId: engineerRiver.id },
            { defectItemId: secondItemId, userId: engineerRiver.id },
          ],
        });

        await tx.defectItemLiableOrganization.createMany({
          data: [
            { defectItemId: firstItemId, organizationId: liableHeating.id },
            { defectItemId: firstItemId, organizationId: liableWindows.id },
            { defectItemId: secondItemId, organizationId: liableWindows.id },
          ],
        });

        await tx.proposal.createMany({
          data: [
            {
              defectItemId: firstItemId,
              slot: 'A',
              alternativeContractorOrganizationId: altA.id,
              amount: new Prisma.Decimal('1250.00'),
              currency: 'BYN',
            },
            {
              defectItemId: firstItemId,
              slot: 'B',
              alternativeContractorOrganizationId: altB.id,
              amount: new Prisma.Decimal('1180.50'),
              currency: 'BYN',
            },
            {
              defectItemId: firstItemId,
              slot: 'C',
              alternativeContractorOrganizationId: altC.id,
              amount: new Prisma.Decimal('1310.00'),
              currency: 'BYN',
            },
          ],
        });

        const items = await tx.defectItem.findMany({ where: { actId: act.id } });
        const status = computeActStatus(
          items.map((item) => ({ status: item.status, active: true })),
        );
        await tx.act.update({
          where: { id: act.id },
          data: { status },
        });
      }
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function upsertOrganization(
  tx: Prisma.TransactionClient,
  input: {
    officialName: string;
    unp: string | null;
    postalAddress: string;
    email: string;
    phone: string;
    contactPerson: string;
    roles: Array<'CUSTOMER' | 'LIABLE_CONTRACTOR' | 'ALTERNATIVE_CONTRACTOR'>;
    workTypeCodes: string[];
  },
) {
  const unp = normalizeUnp(input.unp);
  const existing = unp
    ? await tx.organization.findUnique({ where: { unp } })
    : await tx.organization.findFirst({ where: { officialName: input.officialName } });

  const organization =
    existing ??
    (await tx.organization.create({
      data: {
        officialName: input.officialName,
        unp,
        postalAddress: input.postalAddress,
        email: input.email,
        phone: input.phone,
        contactPerson: input.contactPerson,
      },
    }));

  for (const role of input.roles) {
    await tx.organizationRoleAssignment.upsert({
      where: {
        organizationId_role: { organizationId: organization.id, role },
      },
      update: {},
      create: { organizationId: organization.id, role },
    });
  }

  for (const code of input.workTypeCodes) {
    const workType = await tx.workType.findUnique({ where: { code } });
    if (!workType) {
      continue;
    }
    await tx.organizationWorkType.upsert({
      where: {
        organizationId_workTypeId: { organizationId: organization.id, workTypeId: workType.id },
      },
      update: {},
      create: { organizationId: organization.id, workTypeId: workType.id },
    });
  }

  return organization;
}

seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown seed error';
  console.error(message);
  process.exit(1);
});
