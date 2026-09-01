import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { Prisma } from '@prisma/client';
import {
  BUSINESS_TIME_ZONE,
  addCalendarDays,
  calendarDateInTimeZone,
  calendarDateToUtcNoon,
  computeActStatus,
  normalizeEmail,
  normalizeUnp,
  assertPasswordPolicy,
} from '@sgr-registry/domain';
import argon2 from 'argon2';
import {
  allocateActNumber,
  assertE2eDatabaseTarget,
  createOwnerPrismaClient,
  upsertUserCredentials,
} from '../src/index';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile, override: process.env.SGR_KEEP_PROCESS_ENV !== '1' });

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

const DEMO_USERS = [
  {
    fullName: 'Алексей Викторов',
    email: 'alexey.viktorov@example.sgr.local',
    phone: '+375290000001',
    role: 'ADMIN' as const,
  },
  {
    fullName: 'Марина Соколова',
    email: 'marina.sokolova@example.sgr.local',
    phone: '+375290000002',
    role: 'SGR_MANAGER' as const,
  },
  {
    fullName: 'Дмитрий Орлов',
    email: 'dmitry.orlov@example.sgr.local',
    phone: '+375290000003',
    role: 'RESPONSIBLE_ENGINEER' as const,
  },
  {
    fullName: 'Елена Крылова',
    email: 'elena.krylova@example.sgr.local',
    phone: '+375290000004',
    role: 'RESPONSIBLE_ENGINEER' as const,
  },
  {
    fullName: 'Игорь Пантелеев',
    email: 'igor.panteleev@example.sgr.local',
    phone: '+375290000005',
    role: 'CONTRACTOR_ENGINEER' as const,
  },
] as const;

async function seed(): Promise<void> {
  if (process.env.SGR_REQUIRE_E2E_TARGET === '1') {
    assertE2eDatabaseTarget(process.env);
  }

  const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('MIGRATION_DATABASE_URL is required to seed the database');
  }

  const prisma = createOwnerPrismaClient(databaseUrl);
  const isProduction = process.env.NODE_ENV === 'production';
  const demoPassword = isProduction ? undefined : process.env.SEED_DEMO_PASSWORD;
  if (!isProduction && !demoPassword) {
    throw new Error(
      'SEED_DEMO_PASSWORD is required for development and test seed. Do not use a built-in demo password in production.',
    );
  }

  const emailsNeedingPassword = new Set<string>();
  let preparedDemoPasswordHash: string | undefined;
  if (demoPassword) {
    for (const spec of DEMO_USERS) {
      assertPasswordPolicy(demoPassword, { email: spec.email, fullName: spec.fullName });
    }
    const existing = await prisma.user.findMany({
      where: { email: { in: DEMO_USERS.map((user) => normalizeEmail(user.email)) } },
      include: { credentials: true },
    });
    for (const spec of DEMO_USERS) {
      const email = normalizeEmail(spec.email);
      const user = existing.find((item) => item.email === email);
      if (user?.credentials?.passwordHash) {
        try {
          if (await argon2.verify(user.credentials.passwordHash, demoPassword)) {
            continue;
          }
        } catch {
          // Replace unreadable hashes below.
        }
      }
      emailsNeedingPassword.add(email);
    }
    if (emailsNeedingPassword.size > 0) {
      preparedDemoPasswordHash = await argon2.hash(demoPassword, {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
    }
  }

  try {
    await prisma.$transaction(
      async (tx) => {
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

        await tx.workType.upsert({
          where: { code: 'ARCHIVED_DEMO' },
          update: { active: false, archivedAt: new Date('2026-02-01T12:00:00.000Z') },
          create: {
            code: 'ARCHIVED_DEMO',
            name: 'Архивный вид работ (демо)',
            sortOrder: 99,
            active: false,
            archivedAt: new Date('2026-02-01T12:00:00.000Z'),
          },
        });
        await tx.defectType.upsert({
          where: { code: 'ARCHIVED_DEFECT' },
          update: { active: false, archivedAt: new Date('2026-02-01T12:00:00.000Z') },
          create: {
            code: 'ARCHIVED_DEFECT',
            name: 'Архивный вид дефекта (демо)',
            sortOrder: 99,
            active: false,
            archivedAt: new Date('2026-02-01T12:00:00.000Z'),
          },
        });

        if (isProduction) {
          return;
        }

        const seededUsers = [];
        for (const spec of DEMO_USERS) {
          const email = normalizeEmail(spec.email);
          seededUsers.push(
            await upsertDemoUser(tx, {
              ...spec,
              passwordHash: emailsNeedingPassword.has(email) ? preparedDemoPasswordHash : undefined,
            }),
          );
        }
        const engineerNorth = seededUsers[2];
        const engineerRiver = seededUsers[3];
        if (!engineerNorth || !engineerRiver) {
          throw new Error('Demo engineers were not seeded');
        }

        await tx.user.upsert({
          where: { email: 'archived.user@example.sgr.local' },
          update: { status: 'ARCHIVED', archivedAt: new Date('2026-01-15T12:00:00.000Z') },
          create: {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            fullName: 'Архивный Пользователь',
            email: 'archived.user@example.sgr.local',
            role: 'RESPONSIBLE_ENGINEER',
            status: 'ARCHIVED',
            archivedAt: new Date('2026-01-15T12:00:00.000Z'),
            mustChangePassword: false,
          },
        });
        if (preparedDemoPasswordHash) {
          await upsertUserCredentials(tx, {
            userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            passwordHash: preparedDemoPasswordHash,
          });
        }

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

        await tx.propertyObject.upsert({
          where: { id: '33333333-3333-4333-8333-333333333333' },
          update: { active: false, archivedAt: new Date('2026-02-01T12:00:00.000Z') },
          create: {
            id: '33333333-3333-4333-8333-333333333333',
            name: 'ЖК «Архивный корпус» (демо)',
            address: 'г. Минск, ул. Закрытая, 9',
            active: false,
            archivedAt: new Date('2026-02-01T12:00:00.000Z'),
          },
        });

        await ensureActiveObjectEngineer(tx, northPark.id, engineerNorth.id);
        await ensureActiveObjectEngineer(tx, riverQuarter.id, engineerRiver.id);

        await tx.propertyObjectEngineer.updateMany({
          where: {
            unassignedAt: null,
            OR: [
              { propertyObjectId: northPark.id, userId: { not: engineerNorth.id } },
              { propertyObjectId: riverQuarter.id, userId: { not: engineerRiver.id } },
            ],
          },
          data: { unassignedAt: new Date() },
        });

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

        const sunnyCourt = await tx.propertyObject.upsert({
          where: { id: '33333333-3333-4333-8333-333333333333' },
          update: {},
          create: {
            id: '33333333-3333-4333-8333-333333333333',
            name: 'ЖК «Солнечный двор» (демо)',
            address: 'г. Минск, ул. Светлая, 8',
            commissionedAt: new Date('2023-11-01T00:00:00.000Z'),
            warrantyEndsAt: new Date('2028-11-01T00:00:00.000Z'),
          },
        });

        const customerSouth = await upsertOrganization(tx, {
          officialName: 'УП «Южный заказчик» (демо)',
          unp: '100000007',
          postalAddress: 'г. Минск, ул. Южная, 3',
          email: 'south-customer@example.sgr.local',
          phone: '+375170000007',
          contactPerson: 'Кирилл Юрьев',
          roles: ['CUSTOMER'],
          workTypeCodes: ['GENERAL_CONTRACTING'],
        });

        const liableFacade = await upsertOrganization(tx, {
          officialName: 'ООО «ФасадПро» (демо)',
          unp: '100000008',
          postalAddress: 'г. Минск, ул. Облицовочная, 12',
          email: 'facade@example.sgr.local',
          phone: '+375170000008',
          contactPerson: 'Роман Кладкин',
          roles: ['LIABLE_CONTRACTOR'],
          workTypeCodes: ['FACADE'],
        });

        await seedDemoRegistry(tx, {
          engineerNorth,
          engineerRiver,
          northPark,
          riverQuarter,
          sunnyCourt,
          customer,
          customerSouth,
          liableHeating,
          liableWindows,
          liableFacade,
          altA,
          altB,
          altC,
        });
      },
      { timeout: 120_000 },
    );
  } finally {
    await prisma.$disconnect();
  }
}

type DemoActor = { id: string };
type DemoObject = { id: string };
type DemoOrg = { id: string };

async function seedDemoRegistry(
  tx: Prisma.TransactionClient,
  ctx: {
    engineerNorth: DemoActor;
    engineerRiver: DemoActor;
    northPark: DemoObject;
    riverQuarter: DemoObject;
    sunnyCourt: DemoObject;
    customer: DemoOrg;
    customerSouth: DemoOrg;
    liableHeating: DemoOrg;
    liableWindows: DemoOrg;
    liableFacade: DemoOrg;
    altA: DemoOrg;
    altB: DemoOrg;
    altC: DemoOrg;
  },
): Promise<void> {
  const today = calendarDateInTimeZone(new Date(), BUSINESS_TIME_ZONE);
  const dates = {
    overdue: calendarDateToUtcNoon(addCalendarDays(today, -5)),
    dueToday: calendarDateToUtcNoon(today),
    warning: calendarDateToUtcNoon(addCalendarDays(today, 2)),
    normal: calendarDateToUtcNoon(addCalendarDays(today, 21)),
    completedPlan: calendarDateToUtcNoon(addCalendarDays(today, -20)),
    completedReady: new Date(`${addCalendarDays(today, -18)}T12:00:00.000Z`),
  };

  const types = {
    leakage: await tx.defectType.findUniqueOrThrow({ where: { code: 'LEAKAGE' } }),
    windows: await tx.defectType.findUniqueOrThrow({ where: { code: 'WINDOWS' } }),
    facade: await tx.defectType.findUniqueOrThrow({ where: { code: 'FACADE' } }),
    electrical: await tx.defectType.findUniqueOrThrow({ where: { code: 'ELECTRICAL' } }),
    flooring: await tx.defectType.findUniqueOrThrow({ where: { code: 'FLOORING' } }),
    heating: await tx.defectType.findUniqueOrThrow({ where: { code: 'HEATING_SYSTEM' } }),
    finishing: await tx.defectType.findUniqueOrThrow({ where: { code: 'FINISHING' } }),
  };

  const firstAct = await ensureNumberedAct(tx, {
    officialNumber: 'С-1-2026-000001',
    formCode: 'S1',
    issuedAt: new Date('2026-03-01T09:00:00.000Z'),
    objectId: ctx.northPark.id,
    customerOrganizationId: ctx.customer.id,
    signedDocumentRef: 'https://files.example.sgr.local/demo/s1-000001.pdf',
    cancelled: false,
  });

  await ensureDefectItem(tx, {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    actId: firstAct.id,
    location: 'Подъезд 2, квартира 45, санузел',
    defectTypeId: types.leakage.id,
    status: 'IN_PROGRESS',
    claimDetails: 'Течь стояка холодного водоснабжения на уровне перекрытия.',
    plannedDeadline: dates.normal,
    claimDeadline: dates.overdue,
    notes: 'Демонстрационная строка дефекта',
    engineerIds: [ctx.engineerNorth.id, ctx.engineerRiver.id],
    liableIds: [ctx.liableHeating.id, ctx.liableWindows.id],
    proposals: [
      { slot: 'A', organizationId: ctx.altA.id, amount: '1250.00' },
      { slot: 'B', organizationId: ctx.altB.id, amount: '1180.50' },
      { slot: 'C', organizationId: ctx.altC.id, amount: '1310.00' },
    ],
  });

  await ensureDefectItem(tx, {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    actId: firstAct.id,
    location: 'Подъезд 1, квартира 12, гостиная',
    defectTypeId: types.windows.id,
    status: 'COMPLETED',
    claimDetails: 'Нарушение герметичности оконного блока.',
    plannedDeadline: dates.completedPlan,
    readyAt: dates.completedReady,
    engineerIds: [ctx.engineerRiver.id],
    liableIds: [ctx.liableWindows.id],
    proposals: [],
  });

  const multiAct = await ensureDemoAct(tx, {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01',
    formCode: 'S23',
    issuedAt: new Date('2026-04-02T09:00:00.000Z'),
    objectId: ctx.northPark.id,
    customerOrganizationId: ctx.customer.id,
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc01',
    actId: multiAct.id,
    location: 'Подъезд 3, квартира 18, кухня',
    defectTypeId: types.electrical.id,
    status: 'IN_PROGRESS',
    claimDetails: 'Искрение в распределительной коробке.',
    plannedDeadline: dates.normal,
    engineerIds: [ctx.engineerNorth.id],
    liableIds: [ctx.liableFacade.id],
    proposals: [{ slot: 'A', organizationId: ctx.altA.id, amount: '640.00' }],
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc02',
    actId: multiAct.id,
    location: 'Подъезд 3, квартира 19, лоджия',
    defectTypeId: types.finishing.id,
    status: 'IN_PROGRESS',
    claimDetails: 'Отслоение штукатурки на откосах.',
    plannedDeadline: dates.warning,
    engineerIds: [ctx.engineerRiver.id],
    liableIds: [ctx.liableWindows.id],
    proposals: [{ slot: 'A', organizationId: ctx.altB.id, amount: '410.25' }],
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc03',
    actId: multiAct.id,
    location: 'Подъезд 3, МОП, лестничная клетка',
    defectTypeId: types.facade.id,
    status: 'IN_PROGRESS',
    claimDetails: 'Трещина облицовки у входной группы.',
    plannedDeadline: dates.dueToday,
    engineerIds: [ctx.engineerNorth.id, ctx.engineerRiver.id],
    liableIds: [ctx.liableFacade.id],
    proposals: [
      { slot: 'A', organizationId: ctx.altA.id, amount: '980.00' },
      { slot: 'B', organizationId: ctx.altB.id, amount: '915.40' },
      { slot: 'C', organizationId: ctx.altC.id, amount: '1020.00' },
    ],
  });

  const riverAct = await ensureDemoAct(tx, {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02',
    formCode: 'S1',
    issuedAt: new Date('2026-04-10T09:00:00.000Z'),
    objectId: ctx.riverQuarter.id,
    customerOrganizationId: ctx.customerSouth.id,
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc04',
    actId: riverAct.id,
    location: 'Корпус Б, квартира 7, санузел',
    defectTypeId: types.heating.id,
    status: 'IN_PROGRESS',
    claimDetails: 'Шум в стояке отопления, срок не согласован.',
    engineerIds: [ctx.engineerRiver.id],
    liableIds: [ctx.liableHeating.id],
    proposals: [{ slot: 'A', organizationId: ctx.altA.id, amount: '275.00' }],
  });

  const completedAct = await ensureDemoAct(tx, {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb03',
    formCode: 'S23',
    issuedAt: new Date('2026-02-12T09:00:00.000Z'),
    objectId: ctx.riverQuarter.id,
    customerOrganizationId: ctx.customerSouth.id,
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc05',
    actId: completedAct.id,
    location: 'Корпус А, квартира 2, прихожая',
    defectTypeId: types.flooring.id,
    status: 'COMPLETED',
    claimDetails: 'Сколы напольной плитки у входной двери.',
    plannedDeadline: dates.completedPlan,
    readyAt: dates.completedReady,
    engineerIds: [ctx.engineerRiver.id],
    liableIds: [ctx.liableFacade.id],
    proposals: [{ slot: 'A', organizationId: ctx.altC.id, amount: '190.00' }],
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc06',
    actId: completedAct.id,
    location: 'Корпус А, квартира 2, кухня',
    defectTypeId: types.windows.id,
    status: 'COMPLETED',
    claimDetails: 'Неплотное прилегание створки.',
    plannedDeadline: dates.completedPlan,
    readyAt: dates.completedReady,
    engineerIds: [ctx.engineerNorth.id],
    liableIds: [ctx.liableWindows.id],
    proposals: [],
  });

  const splitAct = await ensureDemoAct(tx, {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb04',
    formCode: 'S1',
    issuedAt: new Date('2026-05-04T09:00:00.000Z'),
    objectId: ctx.sunnyCourt.id,
    customerOrganizationId: ctx.customerSouth.id,
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc07',
    actId: splitAct.id,
    location: 'Секция 1, квартира 11, спальня',
    defectTypeId: types.finishing.id,
    status: 'IN_PROGRESS',
    claimDetails: 'Трещины по шпаклёвке потолка.',
    plannedDeadline: dates.normal,
    engineerIds: [ctx.engineerNorth.id],
    liableIds: [ctx.liableFacade.id],
    proposals: [{ slot: 'A', organizationId: ctx.altA.id, amount: '330.00' }],
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc08',
    actId: splitAct.id,
    location: 'Секция 1, квартира 14, гостиная',
    defectTypeId: types.electrical.id,
    status: 'IN_PROGRESS',
    claimDetails: 'Не работает блок розеток у окна.',
    plannedDeadline: dates.warning,
    claimDeadline: dates.warning,
    engineerIds: [ctx.engineerRiver.id],
    liableIds: [ctx.liableHeating.id],
    proposals: [
      { slot: 'A', organizationId: ctx.altA.id, amount: '510.00' },
      { slot: 'B', organizationId: ctx.altB.id, amount: '495.10' },
      { slot: 'C', organizationId: ctx.altC.id, amount: '540.00' },
    ],
  });

  const warningAct = await ensureDemoAct(tx, {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb05',
    formCode: 'S23',
    issuedAt: new Date('2026-05-18T09:00:00.000Z'),
    objectId: ctx.sunnyCourt.id,
    customerOrganizationId: ctx.customer.id,
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc09',
    actId: warningAct.id,
    location: 'Секция 2, квартира 3, санузел',
    defectTypeId: types.leakage.id,
    status: 'IN_PROGRESS',
    claimDetails: 'Следы протечки у полотенцесушителя.',
    plannedDeadline: dates.warning,
    engineerIds: [ctx.engineerNorth.id, ctx.engineerRiver.id],
    liableIds: [ctx.liableHeating.id],
    proposals: [{ slot: 'A', organizationId: ctx.altB.id, amount: '220.00' }],
  });

  const overdueAct = await ensureDemoAct(tx, {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb06',
    formCode: 'S1',
    issuedAt: new Date('2026-01-20T09:00:00.000Z'),
    objectId: ctx.northPark.id,
    customerOrganizationId: ctx.customer.id,
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc10',
    actId: overdueAct.id,
    location: 'Подъезд 4, квартира 60, лоджия',
    defectTypeId: types.facade.id,
    status: 'IN_PROGRESS',
    claimDetails: 'Отслоение утеплителя на торце лоджии.',
    plannedDeadline: dates.overdue,
    engineerIds: [ctx.engineerNorth.id],
    liableIds: [ctx.liableFacade.id],
    proposals: [{ slot: 'A', organizationId: ctx.altC.id, amount: '870.00' }],
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc11',
    actId: overdueAct.id,
    location: 'Подъезд 4, квартира 61, кухня',
    defectTypeId: types.windows.id,
    status: 'IN_PROGRESS',
    claimDetails: 'Конденсат между стёклами стеклопакета.',
    plannedDeadline: dates.normal,
    engineerIds: [ctx.engineerRiver.id],
    liableIds: [ctx.liableWindows.id],
    proposals: [],
  });

  const sunnyCompleted = await ensureDemoAct(tx, {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb07',
    formCode: 'S23',
    issuedAt: new Date('2026-03-22T09:00:00.000Z'),
    objectId: ctx.sunnyCourt.id,
    customerOrganizationId: ctx.customerSouth.id,
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc12',
    actId: sunnyCompleted.id,
    location: 'Секция 3, квартира 9, спальня',
    defectTypeId: types.flooring.id,
    status: 'COMPLETED',
    claimDetails: 'Щели ламината у батареи.',
    plannedDeadline: dates.completedPlan,
    readyAt: dates.completedReady,
    engineerIds: [ctx.engineerRiver.id],
    liableIds: [ctx.liableFacade.id],
    proposals: [{ slot: 'A', organizationId: ctx.altA.id, amount: '155.00' }],
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc13',
    actId: sunnyCompleted.id,
    location: 'Секция 3, квартира 9, санузел',
    defectTypeId: types.electrical.id,
    status: 'COMPLETED',
    claimDetails: 'Замена выключателя после короткого замыкания.',
    plannedDeadline: dates.completedPlan,
    readyAt: dates.completedReady,
    engineerIds: [ctx.engineerNorth.id, ctx.engineerRiver.id],
    liableIds: [ctx.liableHeating.id],
    proposals: [],
  });

  const extraAct = await ensureDemoAct(tx, {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb08',
    formCode: 'S1',
    issuedAt: new Date('2026-06-01T09:00:00.000Z'),
    objectId: ctx.riverQuarter.id,
    customerOrganizationId: ctx.customer.id,
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc14',
    actId: extraAct.id,
    location: 'Корпус В, квартира 21, гостиная',
    defectTypeId: types.finishing.id,
    status: 'IN_PROGRESS',
    claimDetails: 'Выцветание краски на откосе.',
    plannedDeadline: dates.normal,
    thirdPartyDeadline: dates.normal,
    engineerIds: [ctx.engineerRiver.id],
    liableIds: [ctx.liableWindows.id, ctx.liableFacade.id],
    proposals: [{ slot: 'A', organizationId: ctx.altB.id, amount: '145.00' }],
  });

  const cancelledAct = await ensureDemoAct(tx, {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb09',
    formCode: 'S1',
    issuedAt: new Date('2026-01-05T09:00:00.000Z'),
    objectId: ctx.northPark.id,
    customerOrganizationId: ctx.customer.id,
    cancelled: true,
    cancellationReason: 'Демонстрационное аннулирование ошибочно созданного акта',
  });

  await ensureDefectItem(tx, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc15',
    actId: cancelledAct.id,
    location: 'Аннулированная строка, не должна быть в реестре',
    defectTypeId: types.leakage.id,
    status: 'IN_PROGRESS',
    claimDetails: 'Строка аннулированного акта.',
    plannedDeadline: dates.overdue,
    engineerIds: [ctx.engineerNorth.id],
    liableIds: [ctx.liableHeating.id],
    proposals: [{ slot: 'A', organizationId: ctx.altA.id, amount: '9999.00' }],
  });

  const actIds = [
    firstAct.id,
    multiAct.id,
    riverAct.id,
    completedAct.id,
    splitAct.id,
    warningAct.id,
    overdueAct.id,
    sunnyCompleted.id,
    extraAct.id,
    cancelledAct.id,
  ];
  for (const actId of actIds) {
    const items = await tx.defectItem.findMany({ where: { actId } });
    const act = await tx.act.findUniqueOrThrow({ where: { id: actId } });
    if (act.status === 'CANCELLED') {
      continue;
    }
    await tx.act.update({
      where: { id: actId },
      data: {
        status: computeActStatus(items.map((item) => ({ status: item.status, active: true }))),
      },
    });
  }

  const firstDefect = await tx.defectItem.findFirst({
    where: { actId: firstAct.id },
    orderBy: { location: 'asc' },
  });
  if (firstDefect) {
    const archivedProposal = await tx.proposal.findFirst({
      where: { defectItemId: firstDefect.id, slot: 'C', status: 'ARCHIVED' },
    });
    if (!archivedProposal) {
      await tx.proposal.create({
        data: {
          defectItemId: firstDefect.id,
          slot: 'C',
          alternativeContractorOrganizationId: ctx.altC.id,
          amount: new Prisma.Decimal('10.00'),
          currency: 'BYN',
          status: 'ARCHIVED',
          archivedAt: new Date('2026-04-01T12:00:00.000Z'),
          archiveReason: 'Демонстрационный отзыв предложения',
        },
      });
    }
    const historyCount = await tx.auditLog.count({
      where: { entityType: 'ACT', entityId: firstAct.id, action: 'ACT_CREATED' },
    });
    if (historyCount === 0) {
      await tx.auditLog.createMany({
        data: [
          {
            actorUserId: ctx.engineerNorth.id,
            actorName: 'Дмитрий Орлов',
            action: 'ACT_CREATED',
            entityType: 'ACT',
            entityId: firstAct.id,
            newValue: { officialNumber: 'С-1-2026-000001' },
            source: 'WEB',
            occurredAt: new Date('2026-03-01T10:00:00.000Z'),
          },
          {
            actorUserId: ctx.engineerNorth.id,
            actorName: 'Дмитрий Орлов',
            action: 'DEADLINE_UPDATED',
            entityType: 'DEFECT_ITEM',
            entityId: firstDefect.id,
            parentEntityType: 'ACT',
            parentEntityId: firstAct.id,
            oldValue: { plannedDeadline: '2026-03-10' },
            newValue: { plannedDeadline: '2026-03-20' },
            reason: 'Согласовано продление',
            source: 'WEB',
            occurredAt: new Date('2026-03-05T10:00:00.000Z'),
          },
        ],
      });
    }
  }
}

async function ensureNumberedAct(
  tx: Prisma.TransactionClient,
  input: {
    officialNumber: string;
    formCode: 'S1' | 'S23';
    issuedAt: Date;
    objectId: string;
    customerOrganizationId: string;
    signedDocumentRef?: string | null;
    cancelled?: boolean;
    cancellationReason?: string;
  },
) {
  const existing = await tx.act.findUnique({ where: { officialNumber: input.officialNumber } });
  if (existing) {
    return tx.act.update({
      where: { id: existing.id },
      data: {
        objectId: input.objectId,
        customerOrganizationId: input.customerOrganizationId,
        signedDocumentRef: input.signedDocumentRef ?? existing.signedDocumentRef,
      },
    });
  }
  const number = await allocateActNumber(tx, input.formCode, input.issuedAt);
  return tx.act.create({
    data: {
      officialNumber: number.officialNumber,
      formCode: number.formCode,
      year: number.year,
      sequence: number.sequence,
      objectId: input.objectId,
      customerOrganizationId: input.customerOrganizationId,
      signedDocumentRef: input.signedDocumentRef ?? null,
      issuedOn: input.issuedAt,
      status: input.cancelled ? 'CANCELLED' : 'IN_PROGRESS',
      createdAt: input.issuedAt,
      cancelledAt: input.cancelled ? input.issuedAt : null,
      cancellationReason: input.cancellationReason ?? null,
    },
  });
}

async function ensureDemoAct(
  tx: Prisma.TransactionClient,
  input: {
    id: string;
    formCode: 'S1' | 'S23';
    issuedAt: Date;
    objectId: string;
    customerOrganizationId: string;
    cancelled?: boolean;
    cancellationReason?: string;
  },
) {
  const existing = await tx.act.findUnique({ where: { id: input.id } });
  if (existing) {
    return tx.act.update({
      where: { id: existing.id },
      data: {
        objectId: input.objectId,
        customerOrganizationId: input.customerOrganizationId,
        ...(input.cancelled
          ? {
              status: 'CANCELLED' as const,
              cancelledAt: existing.cancelledAt ?? input.issuedAt,
              cancellationReason: input.cancellationReason ?? existing.cancellationReason,
            }
          : {}),
      },
    });
  }
  const number = await allocateActNumber(tx, input.formCode, input.issuedAt);
  return tx.act.create({
    data: {
      id: input.id,
      officialNumber: number.officialNumber,
      formCode: number.formCode,
      year: number.year,
      sequence: number.sequence,
      objectId: input.objectId,
      customerOrganizationId: input.customerOrganizationId,
      signedDocumentRef: null,
      issuedOn: input.issuedAt,
      status: input.cancelled ? 'CANCELLED' : 'IN_PROGRESS',
      createdAt: input.issuedAt,
      cancelledAt: input.cancelled ? input.issuedAt : null,
      cancellationReason: input.cancellationReason ?? null,
    },
  });
}

async function ensureDefectItem(
  tx: Prisma.TransactionClient,
  input: {
    id: string;
    actId: string;
    location: string;
    defectTypeId: string;
    status: 'IN_PROGRESS' | 'COMPLETED';
    claimDetails: string;
    plannedDeadline?: Date | null;
    claimDeadline?: Date | null;
    readyAt?: Date | null;
    thirdPartyDeadline?: Date | null;
    notes?: string | null;
    engineerIds: string[];
    liableIds: string[];
    proposals: Array<{ slot: 'A' | 'B' | 'C'; organizationId: string; amount: string }>;
  },
) {
  const existing = await tx.defectItem.findUnique({ where: { id: input.id } });
  if (existing) {
    await tx.defectItem.update({
      where: { id: input.id },
      data: {
        location: input.location,
        defectTypeId: input.defectTypeId,
        status: input.status,
        claimDetails: input.claimDetails,
        plannedDeadline: input.plannedDeadline ?? null,
        claimDeadline: input.claimDeadline ?? null,
        readyAt: input.readyAt ?? null,
        thirdPartyDeadline: input.thirdPartyDeadline ?? null,
        notes: input.notes ?? null,
      },
    });
  } else {
    await tx.defectItem.create({
      data: {
        id: input.id,
        actId: input.actId,
        location: input.location,
        defectTypeId: input.defectTypeId,
        status: input.status,
        claimDetails: input.claimDetails,
        plannedDeadline: input.plannedDeadline ?? null,
        claimDeadline: input.claimDeadline ?? null,
        readyAt: input.readyAt ?? null,
        thirdPartyDeadline: input.thirdPartyDeadline ?? null,
        notes: input.notes ?? null,
      },
    });
  }

  await tx.defectItemEngineer.deleteMany({ where: { defectItemId: input.id } });
  await tx.defectItemEngineer.createMany({
    data: input.engineerIds.map((userId) => ({ defectItemId: input.id, userId })),
  });
  await tx.defectItemLiableOrganization.deleteMany({ where: { defectItemId: input.id } });
  await tx.defectItemLiableOrganization.createMany({
    data: input.liableIds.map((organizationId) => ({ defectItemId: input.id, organizationId })),
  });
  await tx.proposal.deleteMany({ where: { defectItemId: input.id } });
  if (input.proposals.length > 0) {
    await tx.proposal.createMany({
      data: input.proposals.map((proposal) => ({
        defectItemId: input.id,
        slot: proposal.slot,
        alternativeContractorOrganizationId: proposal.organizationId,
        amount: new Prisma.Decimal(proposal.amount),
        currency: 'BYN',
      })),
    });
  }
}

async function ensureActiveObjectEngineer(
  tx: Prisma.TransactionClient,
  propertyObjectId: string,
  userId: string,
) {
  await tx.propertyObjectEngineer.upsert({
    where: {
      propertyObjectId_userId: { propertyObjectId, userId },
    },
    create: { propertyObjectId, userId },
    update: { unassignedAt: null, assignedAt: new Date() },
  });
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

async function upsertDemoUser(
  tx: Prisma.TransactionClient,
  input: {
    fullName: string;
    email: string;
    phone: string;
    role: 'ADMIN' | 'SGR_MANAGER' | 'RESPONSIBLE_ENGINEER' | 'CONTRACTOR_ENGINEER';
    passwordHash?: string;
  },
) {
  const email = normalizeEmail(input.email);
  const user = await tx.user.upsert({
    where: { email },
    update: { mustChangePassword: false },
    create: {
      fullName: input.fullName,
      email,
      phone: input.phone,
      role: input.role,
      mustChangePassword: false,
    },
  });

  if (!input.passwordHash) {
    return user;
  }

  const existingCredentials = await tx.userCredential.findUnique({ where: { userId: user.id } });
  await upsertUserCredentials(tx, {
    userId: user.id,
    passwordHash: input.passwordHash,
  });
  return tx.user.update({
    where: { id: user.id },
    data: {
      mustChangePassword: false,
      ...(existingCredentials ? { sessionVersion: { increment: 1 } } : {}),
    },
  });
}

seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown seed error';
  console.error(message);
  process.exit(1);
});
