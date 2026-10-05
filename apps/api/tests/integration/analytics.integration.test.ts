import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from '@sgr-registry/config';
import type { UserRole } from '@sgr-registry/contracts';
import {
  createOwnerPrismaClient,
  upsertUserCredentials,
  type PrismaClient,
} from '@sgr-registry/database';
import {
  CONFIRMED_LAST_FIRST_TOKEN_ORDER,
  CSRF_HEADER_NAME,
  personNameWriteFields,
  SESSION_COOKIE_NAME,
} from '@sgr-registry/domain';
import Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { hashArgon2id } from '../../src/auth/crypto';
import { configureHttpApp } from '../../src/configure-http';

const PASSWORD = 'Dana-SGR-Demo-2026!';
const marker = `analytics-${Date.now().toString(36)}`;

let app: NestFastifyApplication;
let prisma: PrismaClient;
let redis: Redis;
const userIds: string[] = [];
let objectId = '';
let customerId = '';
let ownOrgId = '';
let foreignOrgId = '';
let defectTypeId = '';
let actId = '';
let ownDefectId = '';
let foreignDefectId = '';

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
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: opts.method,
      url: opts.url,
      payload: opts.payload,
      cookies: opts.cookies,
      headers: {
        origin: loadConfig().WEB_ORIGIN,
        ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
    }) as Promise<InjectResponse>;
}

async function createUser(role: UserRole) {
  const email = `${marker}.${role.toLowerCase()}@example.sgr.local`;
  const user = await prisma.user.create({
    data: {
      ...personNameWriteFields(`Аналитика ${role}`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
      email,
      role,
      mustChangePassword: false,
    },
  });
  await upsertUserCredentials(prisma, {
    userId: user.id,
    passwordHash: await hashArgon2id(PASSWORD, { memoryCost: 4096, timeCost: 1 }),
  });
  userIds.push(user.id);
  return user;
}

async function login(email: string) {
  const response = await inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { csrfToken: string };
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value ?? '';
  return { cookie, csrfToken: body.csrfToken };
}

function read(session: { cookie: string }, url: string) {
  return inject({ method: 'GET', url, cookies: { [SESSION_COOKIE_NAME]: session.cookie } });
}

describe('analytics API', () => {
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

    const object = await prisma.propertyObject.create({
      data: { name: `${marker} object`, address: 'Минск' },
    });
    objectId = object.id;
    const customer = await prisma.organization.create({
      data: {
        officialName: `${marker} customer`,
        postalAddress: 'addr',
        email: `${marker}.customer@example.sgr.local`,
        phone: '1',
        contactPerson: 'З',
      },
    });
    const own = await prisma.organization.create({
      data: {
        officialName: `${marker} own`,
        postalAddress: 'addr',
        email: `${marker}.own@example.sgr.local`,
        phone: '1',
        contactPerson: 'С',
      },
    });
    const foreign = await prisma.organization.create({
      data: {
        officialName: `${marker} foreign`,
        postalAddress: 'addr',
        email: `${marker}.foreign@example.sgr.local`,
        phone: '1',
        contactPerson: 'Ч',
      },
    });
    customerId = customer.id;
    ownOrgId = own.id;
    foreignOrgId = foreign.id;
    const defectType = await prisma.defectType.create({
      data: { code: marker.slice(0, 24).toUpperCase(), name: marker, sortOrder: 91 },
    });
    defectTypeId = defectType.id;
    const act = await prisma.act.create({
      data: {
        formCode: 'S1',
        year: 2098,
        sequence: Math.floor(Math.random() * 800_000) + 100_000,
        objectId,
        customerOrganizationId: customerId,
        issuedOn: new Date('2026-05-01T00:00:00.000Z'),
        status: 'IN_PROGRESS',
        startedAt: new Date('2026-05-01T00:00:00.000Z'),
        officialNumber: marker,
      },
    });
    actId = act.id;
    const ownDefect = await prisma.defectItem.create({
      data: { actId, defectTypeId, status: 'IN_PROGRESS', location: 'Свой', claimDetails: 'свой' },
    });
    const foreignDefect = await prisma.defectItem.create({
      data: {
        actId,
        defectTypeId,
        status: 'COMPLETED',
        location: 'Чужой',
        claimDetails: 'чужой',
        readyAt: new Date(),
      },
    });
    ownDefectId = ownDefect.id;
    foreignDefectId = foreignDefect.id;
    await prisma.defectItemLiableOrganization.createMany({
      data: [
        { defectItemId: ownDefectId, organizationId: ownOrgId },
        { defectItemId: foreignDefectId, organizationId: foreignOrgId },
      ],
    });
    await prisma.proposal.create({
      data: {
        defectItemId: ownDefectId,
        slot: 'A',
        alternativeContractorOrganizationId: ownOrgId,
        amount: '9999.00',
        currency: 'BYN',
      },
    });
  });

  afterAll(async () => {
    await prisma.$executeRaw`ALTER TABLE public.defect_financial_impacts DISABLE TRIGGER defect_financial_impacts_guard`;
    await prisma.defectFinancialImpact.deleteMany({
      where: { defectItemId: { in: [ownDefectId, foreignDefectId] } },
    });
    await prisma.$executeRaw`ALTER TABLE public.defect_financial_impacts ENABLE TRIGGER defect_financial_impacts_guard`;
    await prisma.analyticsInsight
      .deleteMany({ where: { plainLanguageExplanation: { contains: marker } } })
      .catch(() => undefined);
    await prisma.proposal.deleteMany({ where: { defectItemId: ownDefectId } });
    await prisma.defectItemLiableOrganization.deleteMany({
      where: { defectItemId: { in: [ownDefectId, foreignDefectId] } },
    });
    await prisma.defectItem.deleteMany({ where: { actId } });
    await prisma.act.deleteMany({ where: { id: actId } });
    await prisma.userOrganizationMembership.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.propertyObjectEngineer.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog
      .deleteMany({ where: { actorUserId: { in: userIds } } })
      .catch(() => undefined);
    await prisma.idempotencyRecord
      .deleteMany({ where: { actorUserId: { in: userIds } } })
      .catch(() => undefined);
    await prisma.organization.deleteMany({
      where: { id: { in: [customerId, ownOrgId, foreignOrgId] } },
    });
    await prisma.propertyObject.deleteMany({ where: { id: objectId } });
    await prisma.defectType.deleteMany({ where: { id: defectTypeId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await app.close();
    await redis.quit();
    await prisma.$disconnect();
  });

  it('scopes aggregates, separates proposals from cost, and blocks mutation for oversight', async () => {
    const admin = await createUser('ADMIN');
    const manager = await createUser('MANAGER');
    const sgr = await createUser('SGR_MANAGER');
    const responsible = await createUser('RESPONSIBLE_ENGINEER');
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const pending = await createUser('PENDING_ROLE');
    const existingSuperAdmin = await prisma.user.findFirst({
      where: { role: 'SUPER_ADMIN' },
      orderBy: { status: 'asc' },
    });
    if (!existingSuperAdmin) {
      throw new Error('super admin is required');
    }
    if (existingSuperAdmin.status !== 'ACTIVE') {
      await prisma.user.update({
        where: { id: existingSuperAdmin.id },
        data: { status: 'ACTIVE', archivedAt: null },
      });
    }
    await prisma.user.update({
      where: { id: existingSuperAdmin.id },
      data: { mustChangePassword: false },
    });
    await upsertUserCredentials(prisma, {
      userId: existingSuperAdmin.id,
      passwordHash: await hashArgon2id(PASSWORD, { memoryCost: 4096, timeCost: 1 }),
    });
    const superAdmin = existingSuperAdmin;
    await prisma.propertyObjectEngineer.create({
      data: { propertyObjectId: objectId, userId: responsible.id },
    });
    await prisma.userOrganizationMembership.create({
      data: { userId: contractor.id, organizationId: ownOrgId, assignedByUserId: admin.id },
    });

    const adminSession = await login(admin.email);
    const overview = await read(adminSession, '/api/analytics/overview');
    expect(overview.statusCode).toBe(200);
    const overviewBody = overview.json() as {
      defects: number;
      companyActualCostByn: string | null;
    };
    const drill = await read(adminSession, '/api/analytics/drilldown?metric=defects&pageSize=100');
    expect(drill.statusCode).toBe(200);
    const drillBody = drill.json() as { total: number };
    expect(drillBody.total).toBe(overviewBody.defects);

    const created = await inject({
      method: 'POST',
      url: `/api/defects/${ownDefectId}/financials`,
      payload: {
        amountType: 'ACTUAL_COST',
        payerType: 'COMPANY',
        amountOriginal: '25.50',
        currency: 'BYN',
        occurredAt: '2026-05-02',
        comment: marker,
      },
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: { [CSRF_HEADER_NAME]: adminSession.csrfToken },
    });
    expect(created.statusCode).toBe(201);
    const impact = created.json() as { id: string; status: string };
    expect(impact.status).toBe('DRAFT');
    const confirmed = await inject({
      method: 'POST',
      url: `/api/defects/${ownDefectId}/financials/${impact.id}/confirm`,
      cookies: { [SESSION_COOKIE_NAME]: adminSession.cookie },
      headers: { [CSRF_HEADER_NAME]: adminSession.csrfToken },
    });
    expect(confirmed.statusCode).toBe(201);
    const costs = await read(adminSession, `/api/analytics/costs?liableOrganizationId=${ownOrgId}`);
    expect(costs.statusCode).toBe(200);
    const costsBody = costs.json() as { companyActualCostByn: string | null };
    expect(costsBody.companyActualCostByn).toBe('25.50');

    for (const roleUser of [manager, sgr]) {
      const session = await login(roleUser.email);
      expect((await read(session, '/api/analytics/overview')).statusCode).toBe(200);
      expect((await read(session, '/api/analytics/costs')).statusCode).toBe(200);
    }

    const responsibleSession = await login(responsible.email);
    const responsibleOverview = await read(responsibleSession, '/api/analytics/overview');
    expect(responsibleOverview.statusCode).toBe(200);
    expect((responsibleOverview.json() as { financialVisible: boolean }).financialVisible).toBe(
      false,
    );
    expect((await read(responsibleSession, '/api/analytics/costs')).statusCode).toBe(403);

    const contractorSession = await login(contractor.email);
    const contractorOverview = await read(contractorSession, '/api/analytics/overview');
    expect(contractorOverview.statusCode).toBe(200);
    const contractorBody = contractorOverview.json() as {
      defects: number;
      financialVisible: boolean;
    };
    expect(contractorBody.financialVisible).toBe(false);
    expect(contractorBody.defects).toBe(1);
    const filters = await read(contractorSession, '/api/analytics/filters');
    expect(JSON.stringify(filters.json())).not.toContain(foreignOrgId);
    expect(JSON.stringify(filters.json())).not.toContain(`${marker} foreign`);
    const hidden = await read(
      contractorSession,
      `/api/analytics/overview?liableOrganizationId=${foreignOrgId}`,
    );
    expect(hidden.statusCode).toBe(200);
    expect((hidden.json() as { defects: number }).defects).toBe(0);
    expect(
      (await read(contractorSession, `/api/defects/${foreignDefectId}/financials`)).statusCode,
    ).toBe(403);

    const superSession = await login(superAdmin.email);
    expect((await read(superSession, '/api/analytics/overview')).statusCode).toBe(200);
    const denied = await inject({
      method: 'POST',
      url: `/api/defects/${ownDefectId}/financials/${impact.id}/void`,
      cookies: { [SESSION_COOKIE_NAME]: superSession.cookie },
      headers: { [CSRF_HEADER_NAME]: superSession.csrfToken },
    });
    expect(denied.statusCode).toBe(403);

    const pendingSession = await login(pending.email);
    expect((await read(pendingSession, '/api/analytics/overview')).statusCode).toBe(403);
    expect(
      (await read(adminSession, '/api/analytics/overview?dateFrom=not-a-date')).statusCode,
    ).toBe(400);
    expect((await read(adminSession, '/api/analytics/process')).statusCode).toBe(200);
    expect((await read(adminSession, '/api/analytics/patterns')).statusCode).toBe(200);
    expect((await read(adminSession, '/api/analytics/data-quality')).statusCode).toBe(200);
    expect((await read(adminSession, '/api/analytics/liability')).statusCode).toBe(200);
    expect((await read(adminSession, '/api/analytics/drilldown?pageSize=1000')).statusCode).toBe(
      400,
    );
  });
});
