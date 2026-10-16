import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from '@sgr-registry/config';
import {
  allocateActNumber,
  createOwnerPrismaClient,
  disconnectPrismaClient,
  Prisma,
  upsertUserCredentials,
  type PrismaClient,
} from '@sgr-registry/database';
import Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/configure-http';
import { hashArgon2id } from '../../src/auth/crypto';
import {
  SESSION_COOKIE_NAME,
  CONFIRMED_LAST_FIRST_TOKEN_ORDER,
  personNameWriteFields,
} from '@sgr-registry/domain';
import type { UserRole } from '@sgr-registry/contracts';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

let app: NestFastifyApplication;
let prisma: PrismaClient;
let redis: Redis;

const createdUserIds: string[] = [];
const createdActIds: string[] = [];

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
  cookies: Array<{ name: string; value: string }>;
}

async function inject(opts: {
  method: 'GET' | 'POST';
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
      'x-request-id': `registry-${Date.now()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(role: UserRole) {
  const email = `registry.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: {
      ...personNameWriteFields(`Реестр ${role}`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
      email,
      role,
    },
  });
  await upsertUserCredentials(prisma, { userId: user.id, passwordHash });
  createdUserIds.push(user.id);
  return user;
}

async function ensureActiveSuperAdmin() {
  const existing = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
  });
  if (!existing) {
    return createUser('SUPER_ADMIN');
  }
  await prisma.user.update({
    where: { id: existing.id },
    data: { mustChangePassword: false },
  });
  await upsertUserCredentials(prisma, {
    userId: existing.id,
    passwordHash: await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 }),
  });
  return existing;
}

async function login(email: string) {
  const response = await inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: DEMO_PASSWORD },
  });
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value;
  if (!cookie) {
    throw new Error('Login did not return a session cookie');
  }
  return cookie;
}

async function authedGet(cookie: string, url: string) {
  return inject({ method: 'GET', url, cookies: { [SESSION_COOKIE_NAME]: cookie } });
}

describe('registry integration', () => {
  let admin: { id: string; email: string };
  let manager: { id: string; email: string };
  let contractor: { id: string; email: string };
  let engineerA: { id: string; email: string };
  let engineerB: { id: string; email: string };
  let engineerC: { id: string; email: string };
  let objectA: { id: string; name: string };
  let objectB: { id: string };
  let customerA: { id: string };
  let customerB: { id: string };
  let liableA: { id: string };
  let liableB: { id: string };
  let altA: { id: string };
  let altB: { id: string };
  let defectType: { id: string };
  let sharedActId: string;
  let splitActId: string;
  let foreignActId: string;
  let cancelledActId: string;
  let assignedItemId: string;
  let foreignItemId: string;
  let sharedItemId: string;
  let sameDeadlineActNumbers: string[];

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

    await prisma.systemSettings.upsert({
      where: { id: 'default' },
      update: { deadlineWarningDays: 3 },
      create: { id: 'default', deadlineWarningDays: 3 },
    });

    admin = await createUser('ADMIN');
    manager = await createUser('SGR_MANAGER');
    contractor = await createUser('CONTRACTOR_ENGINEER');
    engineerA = await createUser('RESPONSIBLE_ENGINEER');
    engineerB = await createUser('RESPONSIBLE_ENGINEER');
    engineerC = await createUser('RESPONSIBLE_ENGINEER');

    const suffix = `${Date.now()}`;
    objectA = await prisma.propertyObject.create({
      data: { name: `Объект Альфа-тест ${suffix}`, address: 'ул. Тестовая, 1' },
    });
    objectB = await prisma.propertyObject.create({
      data: { name: `Объект Бета-секрет ${suffix}`, address: 'ул. Скрытая, 9' },
    });
    await prisma.propertyObjectEngineer.createMany({
      data: [
        { propertyObjectId: objectA.id, userId: engineerA.id },
        { propertyObjectId: objectA.id, userId: engineerB.id },
        { propertyObjectId: objectB.id, userId: engineerC.id },
      ],
    });
    customerA = await prisma.organization.create({
      data: {
        officialName: `Заказчик Альфа ${suffix}`,
        postalAddress: 'а',
        email: `ca.${suffix}@example.sgr.local`,
        phone: '1',
        contactPerson: 'А',
      },
    });
    customerB = await prisma.organization.create({
      data: {
        officialName: `Заказчик Бета-секрет ${suffix}`,
        postalAddress: 'б',
        email: `cb.${suffix}@example.sgr.local`,
        phone: '2',
        contactPerson: 'Б',
      },
    });
    liableA = await prisma.organization.create({
      data: {
        officialName: `Виновный Альфа ${suffix}`,
        postalAddress: 'в',
        email: `la.${suffix}@example.sgr.local`,
        phone: '3',
        contactPerson: 'В',
      },
    });
    liableB = await prisma.organization.create({
      data: {
        officialName: `Виновный Бета-секрет ${suffix}`,
        postalAddress: 'г',
        email: `lb.${suffix}@example.sgr.local`,
        phone: '4',
        contactPerson: 'Г',
      },
    });
    altA = await prisma.organization.create({
      data: {
        officialName: `Альтернатива тест А ${suffix}`,
        postalAddress: 'д',
        email: `aa.${suffix}@example.sgr.local`,
        phone: '5',
        contactPerson: 'Д',
      },
    });
    altB = await prisma.organization.create({
      data: {
        officialName: `Альтернатива тест Б ${suffix}`,
        postalAddress: 'е',
        email: `ab.${suffix}@example.sgr.local`,
        phone: '6',
        contactPerson: 'Е',
      },
    });
    defectType = await prisma.defectType.upsert({
      where: { code: 'REGISTRY_ITEST' },
      update: {},
      create: { code: 'REGISTRY_ITEST', name: 'Тестовый вид дефекта', sortOrder: 90, active: true },
    });

    const sharedAct = await createAct('S1', objectA.id, customerA.id);
    sharedActId = sharedAct.id;
    const sharedItem = await createItem(sharedAct.id, 'Помещение общее', engineerA.id, liableA.id, {
      plannedDeadline: new Date('2026-09-01T12:00:00.000Z'),
      proposals: true,
    });
    sharedItemId = sharedItem.id;
    await prisma.defectItemEngineer.create({
      data: { defectItemId: sharedItem.id, userId: engineerB.id },
    });

    const splitAct = await createAct('S23', objectA.id, customerA.id);
    splitActId = splitAct.id;
    assignedItemId = (
      await createItem(splitAct.id, 'Помещение инженера А', engineerA.id, liableA.id, {
        plannedDeadline: new Date('2026-08-01T12:00:00.000Z'),
        proposals: true,
      })
    ).id;
    foreignItemId = (
      await createItem(splitAct.id, 'Помещение инженера Б', engineerB.id, liableB.id, {
        plannedDeadline: new Date('2026-10-01T12:00:00.000Z'),
        proposals: true,
      })
    ).id;

    const foreignAct = await createAct('S1', objectB.id, customerB.id);
    foreignActId = foreignAct.id;
    await createItem(foreignAct.id, 'Чужой объект', engineerC.id, liableB.id, {
      plannedDeadline: new Date('2026-07-01T12:00:00.000Z'),
      proposals: true,
    });

    const cancelled = await createAct('S1', objectA.id, customerA.id, 'CANCELLED');
    cancelledActId = cancelled.id;
    await createItem(cancelled.id, 'Аннулированная строка', engineerA.id, liableA.id, {
      plannedDeadline: new Date('2026-06-01T12:00:00.000Z'),
    });

    sameDeadlineActNumbers = [];
    for (const suffix of ['tie-a', 'tie-b']) {
      const act = await createAct('S1', objectA.id, customerA.id);
      sameDeadlineActNumbers.push(act.officialNumber);
      await createItem(act.id, `Тай-брейк ${suffix}`, engineerA.id, liableA.id, {
        plannedDeadline: new Date('2026-11-11T12:00:00.000Z'),
      });
    }
  });

  beforeEach(async () => {
    const keys = await redis.keys('sgr-test:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  afterAll(async () => {
    await prisma.emailDelivery.deleteMany({
      where: { recipient: { event: { actId: { in: createdActIds } } } },
    });
    await prisma.notificationRecipient.deleteMany({
      where: { event: { actId: { in: createdActIds } } },
    });
    await prisma.notificationEvent.deleteMany({ where: { actId: { in: createdActIds } } });
    await prisma.slaClock.deleteMany({ where: { defectItem: { actId: { in: createdActIds } } } });
    await prisma.proposal.deleteMany({ where: { defectItem: { actId: { in: createdActIds } } } });
    await prisma.defectItemEngineer.deleteMany({
      where: { defectItem: { actId: { in: createdActIds } } },
    });
    await prisma.defectItemLiableOrganization.deleteMany({
      where: { defectItem: { actId: { in: createdActIds } } },
    });
    await prisma.propertyObjectEngineer.deleteMany({
      where: { propertyObjectId: { in: [objectA.id, objectB.id] } },
    });
    await prisma.defectItem.deleteMany({ where: { actId: { in: createdActIds } } });
    await prisma.act.deleteMany({ where: { id: { in: createdActIds } } });
    await app?.close();
    await redis?.quit();
    await prisma?.$disconnect();
    await disconnectPrismaClient();
  });

  it('lets ADMIN and SGR_MANAGER see every uncancelled fixture row', async () => {
    for (const account of [admin, manager]) {
      const cookie = await login(account.email);
      const response = await authedGet(cookie, '/api/registry/defects?pageSize=200');
      expect(response.statusCode).toBe(200);
      const body = response.json() as { items: Array<{ actId: string }>; totalCount: number };
      const ids = body.items.map((item) => item.actId);
      expect(ids).toContain(sharedActId);
      expect(ids).toContain(splitActId);
      expect(ids).toContain(foreignActId);
      expect(ids).not.toContain(cancelledActId);
    }
  });

  it('shows a contractor only acts of an active organization membership', async () => {
    const emptyCookie = await login(contractor.email);
    const empty = await authedGet(emptyCookie, '/api/registry/defects?pageSize=200');
    expect(empty.statusCode).toBe(200);
    const emptyIds = (empty.json() as { items: Array<{ actId: string }> }).items.map(
      (item) => item.actId,
    );
    expect(emptyIds).not.toContain(sharedActId);
    expect(emptyIds).not.toContain(splitActId);
    expect(emptyIds).not.toContain(foreignActId);
    expect((await authedGet(emptyCookie, `/api/acts/${sharedActId}`)).statusCode).toBe(404);

    const membership = await prisma.userOrganizationMembership.create({
      data: {
        userId: contractor.id,
        organizationId: liableA.id,
        assignedByUserId: admin.id,
      },
    });
    const scopedCookie = await login(contractor.email);
    const scoped = await authedGet(scopedCookie, '/api/registry/defects?pageSize=200');
    const scopedIds = (scoped.json() as { items: Array<{ actId: string }> }).items.map(
      (item) => item.actId,
    );
    expect(scopedIds).toContain(sharedActId);
    expect(scopedIds).toContain(splitActId);
    expect(scopedIds).not.toContain(foreignActId);
    expect(scopedIds).not.toContain(cancelledActId);
    expect((await authedGet(scopedCookie, `/api/acts/${foreignActId}`)).statusCode).toBe(404);
    const foreignBody = JSON.stringify(
      (await authedGet(scopedCookie, `/api/acts/${foreignActId}`)).json(),
    );
    expect(foreignBody).not.toContain(foreignActId);

    await prisma.userOrganizationMembership.update({
      where: { id: membership.id },
      data: { revokedAt: new Date(), revokedByUserId: admin.id },
    });
    const revokedCookie = await login(contractor.email);
    const revoked = await authedGet(revokedCookie, '/api/registry/defects?pageSize=200');
    const revokedIds = (revoked.json() as { items: Array<{ actId: string }> }).items.map(
      (item) => item.actId,
    );
    expect(revokedIds).not.toContain(sharedActId);
  });

  it('lets SUPER_ADMIN see cancelled acts and foreign objects', async () => {
    const superAdmin = await ensureActiveSuperAdmin();
    const cookie = await login(superAdmin.email);
    const response = await authedGet(cookie, '/api/registry/defects?pageSize=200');
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Array<{ actId: string }> };
    const ids = body.items.map((item) => item.actId);
    expect(ids).toContain(cancelledActId);
    expect(ids).toContain(foreignActId);
    expect(ids).toContain(sharedActId);
    const detail = await authedGet(cookie, `/api/acts/${cancelledActId}`);
    expect(detail.statusCode).toBe(200);
    expect(JSON.stringify(detail.json())).not.toMatch(/passwordHash|sessionVersion|objectKey/);
  });

  it('scopes RESPONSIBLE_ENGINEER rows, counts and hidden commercial fields', async () => {
    const cookie = await login(engineerA.email);
    const response = await authedGet(cookie, '/api/registry/defects?pageSize=200');
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<Record<string, unknown>>;
      totalCount: number;
    };
    const rowIds = body.items.map((item) => item.rowId);
    expect(rowIds).toContain(assignedItemId);
    expect(rowIds).toContain(sharedItemId);
    expect(rowIds).toContain(foreignItemId);
    expect(body.items.some((item) => item.actId === foreignActId)).toBe(false);
    expect(body.totalCount).toBe(body.items.length);
    expect(JSON.stringify(body)).not.toMatch(/"slot":"B"/);
    expect(JSON.stringify(body)).not.toMatch(/proposalsBC/);
    const assigned = body.items.find((item) => item.rowId === sharedItemId);
    expect(assigned?.proposalA).toMatchObject({
      amount: '1250.00',
      currency: 'BYN',
      contractorName: expect.stringContaining('Альтернатива тест А'),
    });
    expect(Object.prototype.hasOwnProperty.call(assigned ?? {}, 'proposalsBC')).toBe(false);
    const cookieB = await login(engineerB.email);
    const listB = await authedGet(cookieB, '/api/registry/defects?pageSize=200');
    const idsB = (listB.json() as { items: Array<{ rowId: string; actId: string }> }).items.map(
      (item) => item.rowId,
    );
    expect(idsB).toContain(assignedItemId);
    expect(idsB).toContain(sharedItemId);
    expect(idsB).toContain(foreignItemId);
  });

  it('returns a safe 404 for a foreign act id and shows every defect on an assigned object', async () => {
    const cookie = await login(engineerA.email);
    const missing = await authedGet(cookie, `/api/acts/${foreignActId}`);
    expect(missing.statusCode).toBe(404);
    expect(JSON.stringify(missing.json())).not.toContain(foreignActId);
    const split = await authedGet(cookie, `/api/acts/${splitActId}`);
    expect(split.statusCode).toBe(200);
    const body = split.json() as { defectItems: Array<{ id: string }> };
    expect(body.defectItems.map((item) => item.id).sort()).toEqual(
      [assignedItemId, foreignItemId].sort(),
    );
  });

  it('returns A/B/C to permitted roles and exact proposal decimals', async () => {
    const cookie = await login(admin.email);
    const response = await authedGet(cookie, '/api/registry/defects?pageSize=200');
    const body = response.json() as { items: Array<Record<string, unknown>> };
    const withBC = body.items.find((item) => item.rowId === sharedItemId);
    expect(withBC?.proposalA).toMatchObject({
      amount: '1250.00',
      currency: 'BYN',
      contractorName: expect.stringContaining('Альтернатива тест А'),
    });
    expect(JSON.stringify(withBC?.proposalA)).not.toMatch(/unp|postalAddress|archivedAt|phone/);
    expect(JSON.stringify(withBC)).toMatch(/"slot":"B"/);
    expect(JSON.stringify(withBC)).toContain('1180.50');
    expect(JSON.stringify(withBC)).toMatch(/Альтернатива тест Б/);
  });

  it('accepts supported page sizes and replaces an unsupported size with the default', async () => {
    const cookie = await login(admin.email);
    for (const size of [25, 50, 100, 200]) {
      const response = await authedGet(cookie, `/api/registry/defects?pageSize=${size}`);
      expect(response.statusCode).toBe(200);
      expect((response.json() as { pageSize: number }).pageSize).toBe(size);
    }
    const fallback = await authedGet(cookie, '/api/registry/defects?pageSize=30');
    expect(fallback.statusCode).toBe(200);
    expect((fallback.json() as { pageSize: number }).pageSize).toBe(50);
  });

  it('searches, filters and sorts without loading hidden rows', async () => {
    const cookie = await login(engineerA.email);
    const search = await authedGet(
      cookie,
      `/api/registry/defects?search=${encodeURIComponent('Альфа-тест')}`,
    );
    expect(search.statusCode).toBe(200);
    const searchBody = search.json() as {
      items: Array<{ objectName: string }>;
      totalCount: number;
    };
    expect(searchBody.items.length).toBeGreaterThan(0);
    expect(searchBody.items.every((item) => item.objectName.includes('Альфа'))).toBe(true);

    const combined = await authedGet(
      cookie,
      `/api/registry/defects?formCodes=S23&objectIds=${objectA.id}`,
    );
    const combinedBody = combined.json() as { items: Array<{ formCode: string; rowId: string }> };
    expect(combinedBody.items.every((item) => item.formCode === 'S23')).toBe(true);
    expect(combinedBody.items.map((item) => item.rowId)).toContain(assignedItemId);
    expect(combinedBody.items.map((item) => item.rowId)).toContain(foreignItemId);

    const dates = await authedGet(
      cookie,
      '/api/registry/defects?plannedDeadlineFrom=2026-08-01&plannedDeadlineTo=2026-08-01',
    );
    expect(
      (dates.json() as { items: Array<{ rowId: string }> }).items.map((item) => item.rowId),
    ).toContain(assignedItemId);

    const sorted = await authedGet(
      cookie,
      '/api/registry/defects?sortBy=actNumber&sortDirection=asc&pageSize=200',
    );
    const numbers = (sorted.json() as { items: Array<{ actNumber: string; rowId: string }> }).items
      .filter((item) => sameDeadlineActNumbers.includes(item.actNumber))
      .map((item) => item.actNumber);
    expect([...numbers].sort((a, b) => a.localeCompare(b))).toEqual(numbers);
  });

  it('keeps summary, filter options and proposalASum inside the same access scope', async () => {
    const engineerCookie = await login(engineerA.email);
    const adminCookie = await login(admin.email);
    const summary = await authedGet(engineerCookie, '/api/registry/summary');
    const list = await authedGet(engineerCookie, '/api/registry/defects?pageSize=200');
    const summaryBody = summary.json() as Record<string, unknown>;
    const listBody = list.json() as { totalCount: number };
    expect(summaryBody.total).toBe(listBody.totalCount);
    expect(Object.prototype.hasOwnProperty.call(summaryBody, 'proposalASum')).toBe(false);

    const options = (await authedGet(engineerCookie, '/api/registry/filter-options')).json() as {
      objects: Array<{ label: string }>;
      responsibleEngineers: Array<{ id: string }>;
      customers: Array<{ label: string }>;
    };
    expect(options.objects.some((item) => item.label.includes('Бета-секрет'))).toBe(false);
    expect(options.customers.some((item) => item.label.includes('Бета-секрет'))).toBe(false);
    expect(options.responsibleEngineers.map((item) => item.id)).not.toContain(engineerC.id);

    const adminSummary = (await authedGet(adminCookie, '/api/registry/summary')).json() as {
      proposalASum: string;
      currency: string;
    };
    expect(adminSummary.currency).toBe('BYN');
    expect(adminSummary.proposalASum).toMatch(/^\d+\.\d{2}$/);
    expect(adminSummary.proposalASum.includes('.')).toBe(true);

    const managerSummary = (
      await authedGet(await login(manager.email), '/api/registry/summary')
    ).json() as {
      proposalASum: string;
    };
    expect(managerSummary.proposalASum).toMatch(/^\d+\.\d{2}$/);

    const contractorCookie = await login(contractor.email);
    const contractorSummary = (
      await authedGet(contractorCookie, '/api/registry/summary')
    ).json() as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(contractorSummary, 'proposalASum')).toBe(false);
  });

  it('does not change query structure for an injection payload', async () => {
    const cookie = await login(admin.email);
    const response = await authedGet(
      cookie,
      `/api/registry/defects?search=${encodeURIComponent("'; DROP TABLE acts; --")}`,
    );
    expect(response.statusCode).toBe(200);
    const acts = await prisma.act.count({ where: { id: { in: createdActIds } } });
    expect(acts).toBeGreaterThan(0);
  });

  async function createAct(
    formCode: 'S1' | 'S23',
    objectId: string,
    customerOrganizationId: string,
    status: 'IN_PROGRESS' | 'CANCELLED' = 'IN_PROGRESS',
  ) {
    const issuedAt = new Date('2026-05-01T09:00:00.000Z');
    const number = await allocateActNumber(prisma, formCode, issuedAt);
    const act = await prisma.act.create({
      data: {
        officialNumber: number.officialNumber,
        formCode: number.formCode,
        year: number.year,
        sequence: number.sequence,
        objectId,
        customerOrganizationId,
        status,
        issuedOn: issuedAt,
        createdAt: issuedAt,
        startedAt: status === 'CANCELLED' ? issuedAt : issuedAt,
        cancelledAt: status === 'CANCELLED' ? issuedAt : null,
        cancellationReason: status === 'CANCELLED' ? 'test' : null,
      },
    });
    createdActIds.push(act.id);
    return act;
  }

  async function createItem(
    actId: string,
    location: string,
    engineerId: string,
    liableId: string,
    options: { plannedDeadline?: Date; proposals?: boolean },
  ) {
    const item = await prisma.defectItem.create({
      data: {
        actId,
        location,
        defectTypeId: defectType.id,
        status: 'IN_PROGRESS',
        claimDetails: location,
        plannedDeadline: options.plannedDeadline ?? null,
      },
    });
    await prisma.defectItemEngineer.create({ data: { defectItemId: item.id, userId: engineerId } });
    await prisma.defectItemLiableOrganization.create({
      data: { defectItemId: item.id, organizationId: liableId },
    });
    if (options.proposals) {
      await prisma.proposal.createMany({
        data: [
          {
            defectItemId: item.id,
            slot: 'A',
            alternativeContractorOrganizationId: altA.id,
            amount: new Prisma.Decimal('1250.00'),
            currency: 'BYN',
          },
          {
            defectItemId: item.id,
            slot: 'B',
            alternativeContractorOrganizationId: altB.id,
            amount: new Prisma.Decimal('1180.50'),
            currency: 'BYN',
          },
          {
            defectItemId: item.id,
            slot: 'C',
            alternativeContractorOrganizationId: altA.id,
            amount: new Prisma.Decimal('1310.00'),
            currency: 'BYN',
          },
        ],
      });
    }
    return item;
  }
});
