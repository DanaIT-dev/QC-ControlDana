import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from '@sgr-registry/config';
import {
  createOwnerPrismaClient,
  upsertUserCredentials,
  type PrismaClient,
} from '@sgr-registry/database';
import {
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  CONFIRMED_LAST_FIRST_TOKEN_ORDER,
  personNameWriteFields,
} from '@sgr-registry/domain';
import Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/configure-http';
import { hashArgon2id } from '../../src/auth/crypto';
import type { UserRole } from '@sgr-registry/contracts';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

let app: NestFastifyApplication;
let prisma: PrismaClient;
let redis: Redis;
const createdUserIds: string[] = [];
const createdActIds: string[] = [];
const createdObjectIds: string[] = [];
const createdOrganizationIds: string[] = [];
const createdDefectTypeIds: string[] = [];
const createdImportBatchIds: string[] = [];

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
  cookies: Array<{ name: string; value: string }>;
}

async function inject(opts: {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  payload?: unknown;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
}): Promise<InjectResponse> {
  const instance = app.getHttpAdapter().getInstance();
  return instance.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload,
    cookies: opts.cookies,
    headers: {
      origin: loadConfig().WEB_ORIGIN,
      'x-request-id': `edit-sort-${Date.now()}-${Math.random()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(role: UserRole) {
  const email = `edit-sort.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const user = await prisma.user.create({
    data: {
      ...personNameWriteFields(`Правка ${role}`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
      email,
      role,
    },
  });
  await upsertUserCredentials(prisma, {
    userId: user.id,
    passwordHash: await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 }),
  });
  createdUserIds.push(user.id);
  return user;
}

async function login(email: string) {
  const response = await inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: DEMO_PASSWORD },
  });
  const body = response.json() as { csrfToken: string };
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value ?? '';
  return { body, cookie };
}

async function mutate(
  session: { cookie: string; body: { csrfToken: string } },
  opts: { method: 'POST' | 'PATCH'; url: string; payload?: unknown },
) {
  return inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload ?? {},
    cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    headers: {
      [CSRF_HEADER_NAME]: session.body.csrfToken,
      'idempotency-key': `edit-sort-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    },
  });
}

async function read(session: { cookie: string }, url: string) {
  return inject({
    method: 'GET',
    url,
    cookies: { [SESSION_COOKIE_NAME]: session.cookie },
  });
}

describe('optional defect text and registry act-date sort', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.REDIS_KEY_PREFIX = 'sgr-test';
    const config = loadConfig();
    prisma = createOwnerPrismaClient(config.MIGRATION_DATABASE_URL);
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ logger: false, trustProxy: false }),
      { logger: false },
    );
    await configureHttpApp(app, config);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(async () => {
    const keys = await redis.keys('sgr-test:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  afterAll(async () => {
    const actIds = createdActIds.filter((id) => id.length > 0);
    if (actIds.length > 0) {
      await prisma.emailDelivery.deleteMany({
        where: { recipient: { event: { actId: { in: actIds } } } },
      });
      await prisma.notificationRecipient.deleteMany({
        where: { event: { actId: { in: actIds } } },
      });
      await prisma.notificationEvent.deleteMany({ where: { actId: { in: actIds } } });
      await prisma.slaClock.deleteMany({ where: { defectItem: { actId: { in: actIds } } } });
      await prisma.defectItemEngineer.deleteMany({
        where: { defectItem: { actId: { in: actIds } } },
      });
      await prisma.defectItemLiableOrganization.deleteMany({
        where: { defectItem: { actId: { in: actIds } } },
      });
      await prisma.defectItem.deleteMany({ where: { actId: { in: actIds } } });
      await prisma.act.deleteMany({ where: { id: { in: actIds } } });
    }
    if (createdImportBatchIds.length > 0) {
      await prisma.importBatch.deleteMany({ where: { id: { in: createdImportBatchIds } } });
    }
    if (createdObjectIds.length > 0) {
      await prisma.propertyObjectEngineer.deleteMany({
        where: { propertyObjectId: { in: createdObjectIds } },
      });
      await prisma.propertyObject.deleteMany({ where: { id: { in: createdObjectIds } } });
    }
    if (createdOrganizationIds.length > 0) {
      await prisma.organizationRoleAssignment.deleteMany({
        where: { organizationId: { in: createdOrganizationIds } },
      });
      await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
    }
    if (createdDefectTypeIds.length > 0) {
      await prisma.defectType.deleteMany({ where: { id: { in: createdDefectTypeIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.idempotencyRecord.deleteMany({
        where: { actorUserId: { in: createdUserIds } },
      });
      await prisma.auditLog
        .deleteMany({ where: { actorUserId: { in: createdUserIds } } })
        .catch(() => undefined);
      await prisma.user
        .deleteMany({ where: { id: { in: createdUserIds } } })
        .catch(() => undefined);
    }
    await app.close();
    await redis.quit();
    await prisma.$disconnect();
  });

  it('saves a defect with empty location and description and keeps omitted fields', async () => {
    const admin = await createUser('ADMIN');
    const outsider = await createUser('RESPONSIBLE_ENGINEER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const session = await login(admin.email);
    const outsiderSession = await login(outsider.email);
    const contractorSession = await login(contractor.email);
    const suffix = Math.random().toString(16).slice(2, 8);
    const object = await prisma.propertyObject.create({
      data: { name: `Объект правки ${suffix}`, address: 'Минск' },
    });
    createdObjectIds.push(object.id);
    const customer = await prisma.organization.create({
      data: {
        officialName: `Заказчик правки ${suffix}`,
        postalAddress: 'addr',
        email: `edit-${suffix}@example.sgr.local`,
        phone: '1',
        contactPerson: 'К',
        roles: { create: [{ role: 'CUSTOMER' }] },
      },
    });
    createdOrganizationIds.push(customer.id);
    const firstType = await prisma.defectType.create({
      data: { code: `ED1-${suffix}`, name: `Вид А ${suffix}`, sortOrder: 10 },
    });
    const secondType = await prisma.defectType.create({
      data: { code: `ED2-${suffix}`, name: `Вид Б ${suffix}`, sortOrder: 11 },
    });
    createdDefectTypeIds.push(firstType.id, secondType.id);
    const created = await mutate(session, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: object.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-04-02',
        defectItems: [
          {
            location: 'Кухня',
            defectTypeId: firstType.id,
            claimDetails: 'Трещина',
            notes: 'Заметка',
          },
          {
            location: 'Ванная',
            defectTypeId: firstType.id,
            claimDetails: 'Соседнее описание',
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const actId = (created.json() as { id: string }).id;
    createdActIds.push(actId);
    expect(
      (await mutate(session, { method: 'POST', url: `/api/acts/${actId}/start` })).statusCode,
    ).toBe(200);
    const detail = (await read(session, `/api/acts/${actId}`)).json() as {
      issuedOn: string;
      defectItems: Array<{
        id: string;
        version: number;
        location: string | null;
        claimDetails: string | null;
        notes: string | null;
        defectTypeId: string | null;
      }>;
    };
    const target = detail.defectItems.find((item) => item.location === 'Кухня')!;
    const sibling = detail.defectItems.find((item) => item.location === 'Ванная')!;
    const noticesBefore = await prisma.notificationEvent.count({ where: { actId } });
    const attachmentsBefore = await prisma.attachment.count({ where: { actId } });

    const cleared = await mutate(session, {
      method: 'PATCH',
      url: `/api/defects/${target.id}`,
      payload: {
        expectedVersion: target.version,
        location: '',
        claimDetails: '',
        defectTypeId: secondType.id,
      },
    });
    expect(cleared.statusCode).toBe(200);
    const afterClear = await prisma.defectItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(afterClear.location).toBeNull();
    expect(afterClear.claimDetails).toBeNull();
    expect(afterClear.notes).toBe('Заметка');
    expect(afterClear.defectTypeId).toBe(secondType.id);
    expect(afterClear.status).toBe('IN_PROGRESS');

    const onlyLocation = await mutate(session, {
      method: 'PATCH',
      url: `/api/defects/${target.id}`,
      payload: { expectedVersion: afterClear.version, location: 'Холл' },
    });
    expect(onlyLocation.statusCode).toBe(200);
    const located = await prisma.defectItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(located.location).toBe('Холл');
    expect(located.claimDetails).toBeNull();

    const onlyDetails = await mutate(session, {
      method: 'PATCH',
      url: `/api/defects/${target.id}`,
      payload: { expectedVersion: located.version, claimDetails: 'Только описание' },
    });
    expect(onlyDetails.statusCode).toBe(200);
    const described = await prisma.defectItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(described.location).toBe('Холл');
    expect(described.claimDetails).toBe('Только описание');

    const clearLocation = await mutate(session, {
      method: 'PATCH',
      url: `/api/defects/${target.id}`,
      payload: { expectedVersion: described.version, location: '   ' },
    });
    expect(clearLocation.statusCode).toBe(200);
    const locationCleared = await prisma.defectItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(locationCleared.location).toBeNull();
    expect(locationCleared.claimDetails).toBe('Только описание');

    const clearBoth = await mutate(session, {
      method: 'PATCH',
      url: `/api/defects/${target.id}`,
      payload: { expectedVersion: locationCleared.version, location: '  ', claimDetails: ' \n ' },
    });
    expect(clearBoth.statusCode).toBe(200);
    const bothCleared = await prisma.defectItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(bothCleared.location).toBeNull();
    expect(bothCleared.claimDetails).toBeNull();

    const omitted = await mutate(session, {
      method: 'PATCH',
      url: `/api/defects/${target.id}`,
      payload: { expectedVersion: bothCleared.version, notes: 'Новая заметка' },
    });
    expect(omitted.statusCode).toBe(200);
    const kept = await prisma.defectItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(kept.location).toBeNull();
    expect(kept.claimDetails).toBeNull();
    expect(kept.notes).toBe('Новая заметка');
    expect(kept.defectTypeId).toBe(secondType.id);

    const reloaded = (await read(session, `/api/acts/${actId}`)).json() as {
      issuedOn: string;
      defectItems: Array<{
        id: string;
        location: string | null;
        claimDetails: string | null;
        defectTypeId: string | null;
      }>;
    };
    const visible = reloaded.defectItems.find((item) => item.id === target.id)!;
    expect(visible.location).toBeNull();
    expect(visible.claimDetails).toBeNull();
    expect(visible.defectTypeId).toBe(secondType.id);
    expect(reloaded.issuedOn).toBe(detail.issuedOn);
    expect(reloaded.defectItems.find((item) => item.id === sibling.id)?.location).toBe('Ванная');
    expect(await prisma.notificationEvent.count({ where: { actId } })).toBe(noticesBefore);
    expect(await prisma.attachment.count({ where: { actId } })).toBe(attachmentsBefore);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: target.id, action: 'DEFECT_UPDATED' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.actorUserId).toBe(admin.id);

    const tooLong = await mutate(session, {
      method: 'PATCH',
      url: `/api/defects/${target.id}`,
      payload: { expectedVersion: kept.version, location: 'Я'.repeat(201) },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(
      (await prisma.defectItem.findUniqueOrThrow({ where: { id: target.id } })).location,
    ).toBeNull();

    const stale = await mutate(session, {
      method: 'PATCH',
      url: `/api/defects/${target.id}`,
      payload: { expectedVersion: target.version, location: 'Чужая версия' },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (await prisma.defectItem.findUniqueOrThrow({ where: { id: target.id } })).location,
    ).toBeNull();
    expect(
      (
        await mutate(outsiderSession, {
          method: 'PATCH',
          url: `/api/defects/${target.id}`,
          payload: { expectedVersion: kept.version, location: 'Чужой' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await mutate(contractorSession, {
          method: 'PATCH',
          url: `/api/defects/${target.id}`,
          payload: { expectedVersion: kept.version, claimDetails: 'Подрядчик' },
        })
      ).statusCode,
    ).toBe(403);

    const batch = await prisma.importBatch.create({
      data: {
        sourceSystem: 'excel',
        sourceFileName: `import-${suffix}.xlsx`,
        sourceFileSha256: 'b'.repeat(64),
        sourceSheet: 'Лист',
        environment: 'test',
        databaseName: 'sgr_registry_test',
        status: 'COMPLETED',
        startedAt: new Date(),
      },
    });
    createdImportBatchIds.push(batch.id);
    await prisma.defectItem.update({
      where: { id: sibling.id },
      data: { importBatchId: batch.id },
    });
    const imported = await prisma.defectItem.findUniqueOrThrow({ where: { id: sibling.id } });
    const importedSave = await mutate(session, {
      method: 'PATCH',
      url: `/api/defects/${sibling.id}`,
      payload: {
        expectedVersion: imported.version,
        location: '',
        claimDetails: '',
        defectTypeId: secondType.id,
      },
    });
    expect(importedSave.statusCode).toBe(200);
    const importedStored = await prisma.defectItem.findUniqueOrThrow({ where: { id: sibling.id } });
    expect(importedStored.location).toBeNull();
    expect(importedStored.claimDetails).toBeNull();
    expect(importedStored.defectTypeId).toBe(secondType.id);
    expect(importedStored.importBatchId).toBe(batch.id);
  });

  it('sorts the registry by act date before pagination and keeps an explicit sort', async () => {
    const admin = await createUser('ADMIN');
    const outsider = await createUser('RESPONSIBLE_ENGINEER');
    const session = await login(admin.email);
    const outsiderSession = await login(outsider.email);
    const marker = `SORT${Math.random().toString(16).slice(2, 10)}`;
    const lateObject = await prisma.propertyObject.create({
      data: { name: `Якорь ${marker}`, address: marker },
    });
    const earlyObject = await prisma.propertyObject.create({
      data: { name: `Альфа ${marker}`, address: marker },
    });
    const blankObject = await prisma.propertyObject.create({
      data: { name: `Бета ${marker}`, address: marker },
    });
    const emptyObject = await prisma.propertyObject.create({
      data: { name: `Пустой ${marker}`, address: marker },
    });
    createdObjectIds.push(lateObject.id, earlyObject.id, blankObject.id, emptyObject.id);
    const customer = await prisma.organization.create({
      data: {
        officialName: `Заказчик ${marker}`,
        postalAddress: marker,
        email: `sort-${marker}@example.sgr.local`,
        phone: '1',
        contactPerson: 'К',
        roles: { create: [{ role: 'CUSTOMER' }] },
      },
    });
    createdOrganizationIds.push(customer.id);
    const defectType = await prisma.defectType.create({
      data: { code: `SRT-${marker}`, name: `Вид ${marker}`, sortOrder: 12 },
    });
    createdDefectTypeIds.push(defectType.id);

    async function actWith(input: {
      objectId: string;
      issuedOn: string | null;
      location: string;
      createdAt?: Date;
    }) {
      const created = await mutate(session, {
        method: 'POST',
        url: '/api/acts',
        payload: {
          formCode: 'S1',
          objectId: input.objectId,
          customerOrganizationId: customer.id,
          issuedOn: input.issuedOn,
          defectItems: [
            { location: input.location, defectTypeId: defectType.id, claimDetails: marker },
          ],
        },
      });
      expect(created.statusCode).toBe(201);
      const actId = (created.json() as { id: string }).id;
      createdActIds.push(actId);
      if (input.createdAt) {
        await prisma.act.update({ where: { id: actId }, data: { createdAt: input.createdAt } });
      }
      return actId;
    }

    const lateId = await actWith({
      objectId: lateObject.id,
      issuedOn: '2026-11-01',
      location: `Поздний ${marker}`,
      createdAt: new Date('2026-11-01T08:00:00.000Z'),
    });
    const secondLate = await mutate(session, {
      method: 'POST',
      url: `/api/acts/${lateId}/defects`,
      payload: {
        expectedActVersion: (await prisma.act.findUniqueOrThrow({ where: { id: lateId } })).version,
        location: `Поздний второй ${marker}`,
        defectTypeId: defectType.id,
        claimDetails: marker,
      },
    });
    expect(secondLate.statusCode).toBe(201);
    const earlyId = await actWith({
      objectId: earlyObject.id,
      issuedOn: '2020-01-15',
      location: `Ранний ${marker}`,
      createdAt: new Date('2026-11-05T08:00:00.000Z'),
    });
    const blankId = await actWith({
      objectId: blankObject.id,
      issuedOn: null,
      location: `Без даты ${marker}`,
      createdAt: new Date('2026-11-05T09:00:00.000Z'),
    });
    const sameDateOlder = await actWith({
      objectId: earlyObject.id,
      issuedOn: '2024-05-05',
      location: `Равная старая ${marker}`,
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    const sameDateNewer = await actWith({
      objectId: lateObject.id,
      issuedOn: '2024-05-05',
      location: `Равная новая ${marker}`,
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    const empty = await mutate(session, {
      method: 'POST',
      url: '/api/acts',
      payload: {
        formCode: 'S1',
        objectId: emptyObject.id,
        customerOrganizationId: customer.id,
        issuedOn: '2026-06-15',
      },
    });
    expect(empty.statusCode).toBe(201);
    const emptyId = (empty.json() as { id: string }).id;
    createdActIds.push(emptyId);

    const listed = await read(session, `/api/registry/defects?search=${marker}&pageSize=25`);
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as {
      appliedSort: { sortBy: string; sortDirection: string };
      pageSize: number;
      items: Array<{ actId: string; defectItemId: string | null; location: string | null }>;
    };
    expect(body.appliedSort).toEqual({ sortBy: 'issuedOn', sortDirection: 'desc' });
    expect(body.pageSize).toBe(25);
    const actOrder = body.items.map((item) => item.actId);
    expect(actOrder.indexOf(lateId)).toBeLessThan(actOrder.indexOf(emptyId));
    expect(actOrder.indexOf(emptyId)).toBeLessThan(actOrder.indexOf(sameDateNewer));
    expect(actOrder.indexOf(sameDateNewer)).toBeLessThan(actOrder.indexOf(sameDateOlder));
    expect(actOrder.indexOf(sameDateOlder)).toBeLessThan(actOrder.indexOf(earlyId));
    expect(actOrder.indexOf(earlyId)).toBeLessThan(actOrder.indexOf(blankId));
    const lateRows = body.items.filter((item) => item.actId === lateId);
    expect(lateRows).toHaveLength(2);
    expect(actOrder.indexOf(lateId)).toBe(actOrder.lastIndexOf(lateId) - 1);
    const lateIds = lateRows.map((item) => item.defectItemId ?? '').sort();
    expect(lateRows.map((item) => item.defectItemId)).toEqual(lateIds);

    const manual = await read(
      session,
      `/api/registry/defects?search=${marker}&sortBy=objectName&sortDirection=asc&pageSize=25&statuses=NEW`,
    );
    const manualBody = manual.json() as {
      appliedSort: { sortBy: string; sortDirection: string };
      pageSize: number;
      items: Array<{ actId: string; objectName: string | null }>;
    };
    expect(manualBody.appliedSort).toEqual({ sortBy: 'objectName', sortDirection: 'asc' });
    expect(manualBody.pageSize).toBe(25);
    const names = manualBody.items.map((item) => item.objectName ?? '');
    expect([...names].sort((left, right) => left.localeCompare(right, 'ru'))).toEqual(names);

    const hidden = await read(
      outsiderSession,
      `/api/registry/defects?search=${marker}&pageSize=50`,
    );
    expect(
      (hidden.json() as { items: Array<{ actId: string }> }).items.map((item) => item.actId),
    ).not.toContain(lateId);
    expect((await read(outsiderSession, `/api/acts/${lateId}`)).statusCode).toBe(404);

    const pageActs = [];
    for (let index = 0; index < 26; index += 1) {
      const act = await prisma.act.create({
        data: {
          objectId: lateObject.id,
          customerOrganizationId: customer.id,
          status: 'NEW',
          issuedOn: new Date(Date.UTC(2030, 0, index + 1, 12)),
          createdAt: new Date(Date.UTC(2030, 0, index + 1, 8)),
          sourceActNumberRaw: `${marker}-page-${index}`,
        },
      });
      createdActIds.push(act.id);
      await prisma.defectItem.create({
        data: {
          actId: act.id,
          location: `${marker} page ${index}`,
          claimDetails: marker,
          defectTypeId: defectType.id,
          status: 'IN_PROGRESS',
        },
      });
      pageActs.push(act.id);
    }
    const firstPage = (
      await read(session, `/api/registry/defects?search=${marker}%20page&pageSize=25&page=1`)
    ).json() as { items: Array<{ actId: string }>; totalCount: number };
    const secondPage = (
      await read(session, `/api/registry/defects?search=${marker}%20page&pageSize=25&page=2`)
    ).json() as { items: Array<{ actId: string }> };
    const seen = [...firstPage.items, ...secondPage.items].map((item) => item.actId);
    expect(firstPage.totalCount).toBe(26);
    expect(new Set(seen).size).toBe(26);
    expect(seen).toHaveLength(26);
    expect(firstPage.items[0]?.actId).toBe(pageActs[25]);
    expect(secondPage.items.at(-1)?.actId).toBe(pageActs[0]);
  });
});
