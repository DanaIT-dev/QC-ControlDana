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

    await prisma.analyticsInsightDefect.deleteMany({
      where: { defectItem: { act: { officialNumber: { startsWith: 'analytics-' } } } },
    });
    await prisma.$executeRaw`ALTER TABLE public.defect_financial_impacts DISABLE TRIGGER defect_financial_impacts_guard`;
    await prisma.defectFinancialImpact.deleteMany({
      where: { defectItem: { act: { officialNumber: { startsWith: 'analytics-' } } } },
    });
    await prisma.$executeRaw`ALTER TABLE public.defect_financial_impacts ENABLE TRIGGER defect_financial_impacts_guard`;
    await prisma.defectItemLiableOrganization.deleteMany({
      where: { defectItem: { act: { officialNumber: { startsWith: 'analytics-' } } } },
    });
    await prisma.defectItem.deleteMany({
      where: { act: { officialNumber: { startsWith: 'analytics-' } } },
    });
    await prisma.act.deleteMany({ where: { officialNumber: { startsWith: 'analytics-' } } });

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
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
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
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        readyAt: new Date('2026-06-01T00:00:00.000Z'),
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
    await prisma.analyticsInsightDefect.deleteMany({ where: { defectItem: { actId } } });
    await prisma.analyticsInsight
      .deleteMany({ where: { plainLanguageExplanation: { contains: marker } } })
      .catch(() => undefined);
    await prisma.proposal.deleteMany({ where: { defectItemId: ownDefectId } });
    await prisma.defectItemLiableOrganization.deleteMany({
      where: { defectItem: { actId } },
    });
    const customerActIds = customerId
      ? (
          await prisma.act.findMany({
            where: { customerOrganizationId: customerId },
            select: { id: true },
          })
        ).map((row) => row.id)
      : [];
    const actIds = [...new Set([actId, ...customerActIds].filter(Boolean))];
    if (actIds.length > 0) {
      await prisma.analyticsInsightDefect.deleteMany({
        where: { defectItem: { actId: { in: actIds } } },
      });
      await prisma.defectItemLiableOrganization.deleteMany({
        where: { defectItem: { actId: { in: actIds } } },
      });
      await prisma.proposal.deleteMany({ where: { defectItem: { actId: { in: actIds } } } });
      await prisma.defectItem.deleteMany({ where: { actId: { in: actIds } } });
      await prisma.act.deleteMany({ where: { id: { in: actIds } } });
    }
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
    const superAdmin = existingSuperAdmin ?? (await createUser('SUPER_ADMIN'));
    if (existingSuperAdmin && existingSuperAdmin.status !== 'ACTIVE') {
      await prisma.user.update({
        where: { id: existingSuperAdmin.id },
        data: { status: 'ACTIVE', archivedAt: null },
      });
    }
    await prisma.user.update({
      where: { id: superAdmin.id },
      data: { mustChangePassword: false },
    });
    await upsertUserCredentials(prisma, {
      userId: superAdmin.id,
      passwordHash: await hashArgon2id(PASSWORD, { memoryCost: 4096, timeCost: 1 }),
    });
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
    expect((await read(responsibleSession, '/api/analytics/overview')).statusCode).toBe(403);
    expect((await read(responsibleSession, '/api/analytics/costs')).statusCode).toBe(403);

    const contractorSession = await login(contractor.email);
    expect((await read(contractorSession, '/api/analytics/overview')).statusCode).toBe(403);
    expect((await read(contractorSession, '/api/analytics/filters')).statusCode).toBe(403);
    expect(
      (
        await read(
          contractorSession,
          `/api/analytics/overview?liableOrganizationId=${foreignOrgId}`,
        )
      ).statusCode,
    ).toBe(403);
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
    expect(denied.statusCode).toBe(400);

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

    const workType = await prisma.workType.create({
      data: { code: marker.slice(0, 20), name: `${marker} work`, sortOrder: 3 },
    });
    const accepted = await prisma.user.findFirstOrThrow({
      where: { email: { startsWith: marker } },
      select: { id: true },
    });
    async function completed(orgId: string, location: string) {
      const defect = await prisma.defectItem.create({
        data: {
          actId,
          defectTypeId,
          workTypeId: workType.id,
          status: 'COMPLETED',
          location,
          claimDetails: location,
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
          readyAt: new Date('2026-06-01T00:00:00.000Z'),
        },
      });
      await prisma.defectItemLiableOrganization.create({
        data: { defectItemId: defect.id, organizationId: orgId },
      });
      return defect.id;
    }
    for (let index = 0; index < 20; index += 1) {
      const id = await completed(foreignOrgId, `baseline-${index}`);
      await prisma.defectInspectionAttempt.create({
        data: {
          defectItemId: id,
          attemptNumber: 1,
          status: 'ACCEPTED',
          submittedByUserId: accepted.id,
          submittedAt: new Date('2026-05-02T00:00:00.000Z'),
          reviewedByUserId: admin.id,
          reviewedAt: new Date('2026-05-03T00:00:00.000Z'),
        },
      });
    }
    const supportIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const id = await completed(ownOrgId, `rework-${index}`);
      supportIds.push(id);
      await prisma.defectInspectionAttempt.createMany({
        data: [
          {
            defectItemId: id,
            attemptNumber: 1,
            status: 'REJECTED',
            submittedByUserId: accepted.id,
            submittedAt: new Date('2026-05-02T00:00:00.000Z'),
            reviewedByUserId: admin.id,
            reviewedAt: new Date('2026-05-03T00:00:00.000Z'),
            rejectionReason: 'повтор',
          },
          {
            defectItemId: id,
            attemptNumber: 2,
            status: 'ACCEPTED',
            submittedByUserId: accepted.id,
            submittedAt: new Date('2026-05-04T00:00:00.000Z'),
            reviewedByUserId: admin.id,
            reviewedAt: new Date('2026-05-05T00:00:00.000Z'),
          },
        ],
      });
    }
    await completed(ownOrgId, 'legacy-without-attempt');
    const patterns = await read(adminSession, '/api/analytics/patterns');
    expect(patterns.statusCode).toBe(200);
    const cards = (
      patterns.json() as { items: Array<{ id: string; signalType: string; supportCount: number }> }
    ).items;
    const low = cards.find(
      (item) => item.signalType === 'LOW_FIRST_TIME_RIGHT' && item.supportCount === 6,
    );
    expect(low).toBeTruthy();
    const support = await read(adminSession, `/api/analytics/patterns/${low?.id}/defects`);
    expect(support.statusCode).toBe(200);
    const supportBody = support.json() as {
      supportCount: number;
      ruleVersion: string;
      items: Array<{ defectItemId: string; contributionReason: string }>;
    };
    expect(supportBody.supportCount).toBe(6);
    expect(supportBody.ruleVersion).toBe('2026.10.05.2');
    expect(supportBody.items.map((item) => item.defectItemId).sort()).toEqual(supportIds.sort());
    expect(supportBody.items[0]?.contributionReason).toContain('First-Time-Right');
    expect(
      (await read(adminSession, `/api/analytics/patterns/${low?.id}/defects?dateFrom=2026-01-01`))
        .statusCode,
    ).toBe(400);
    expect(
      (await read(contractorSession, `/api/analytics/patterns/${low?.id}/defects`)).statusCode,
    ).toBe(403);
    const exposure = (
      (await read(adminSession, '/api/analytics/overview')).json() as {
        confirmedFinancialExposure?: { netConfirmedExposureByn?: string };
        topRisks: Array<{ defectItemId: string }>;
      }
    ).confirmedFinancialExposure;
    expect(exposure?.netConfirmedExposureByn).toBe('25.50');
  });

  it('counts new insights through support intersection and drops reversed durations', async () => {
    const leftoverDefects = await prisma.defectItem.findMany({
      where: {
        location: {
          in: [
            'filter-primary',
            'filter-second',
            'filter-object',
            'filter-org',
            'filter-completed',
            'reversed-duration',
          ],
        },
      },
      select: { id: true },
    });
    const leftoverIds = leftoverDefects.map((row) => row.id);
    if (leftoverIds.length > 0) {
      await prisma.analyticsInsightDefect.deleteMany({
        where: { defectItemId: { in: leftoverIds } },
      });
      await prisma.defectItemLiableOrganization.deleteMany({
        where: { defectItemId: { in: leftoverIds } },
      });
      await prisma.defectItem.deleteMany({ where: { id: { in: leftoverIds } } });
    }
    await prisma.act.deleteMany({ where: { officialNumber: { endsWith: '-filter' } } });
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: `${marker}.admin@example.sgr.local` },
    });
    const contractor = await prisma.user.findFirstOrThrow({
      where: { email: `${marker}.contractor_engineer@example.sgr.local` },
    });
    const responsible = await prisma.user.findFirstOrThrow({
      where: { email: `${marker}.responsible_engineer@example.sgr.local` },
    });
    const workType = await prisma.workType.create({
      data: { code: `${marker}-filter`, name: `${marker} work filter`, sortOrder: 8 },
    });
    const otherObject = await prisma.propertyObject.create({
      data: { name: `${marker} other object`, address: 'Минск' },
    });
    const otherAct = await prisma.act.create({
      data: {
        formCode: 'S1',
        year: 2097,
        sequence: Math.floor(Math.random() * 700_000) + 100_000,
        objectId: otherObject.id,
        customerOrganizationId: customerId,
        issuedOn: new Date('2026-04-01T00:00:00.000Z'),
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
        status: 'IN_PROGRESS',
        startedAt: new Date('2026-04-01T00:00:00.000Z'),
        officialNumber: `${marker}-filter`,
      },
    });
    async function defect(
      targetActId: string,
      location: string,
      options: {
        orgId: string;
        status?: 'IN_PROGRESS' | 'COMPLETED';
        workTypeId?: string;
        createdAt: Date;
      },
    ) {
      return prisma.defectItem.create({
        data: {
          actId: targetActId,
          defectTypeId,
          workTypeId: options.workTypeId,
          status: options.status ?? 'IN_PROGRESS',
          location,
          claimDetails: location,
          createdAt: options.createdAt,
          readyAt: options.status === 'COMPLETED' ? new Date('2026-04-20T00:00:00.000Z') : null,
          liableOrganizations: { create: { organizationId: options.orgId } },
        },
      });
    }
    const primary = await defect(actId, 'filter-primary', {
      orgId: ownOrgId,
      workTypeId: workType.id,
      createdAt: new Date('2026-04-10T00:00:00.000Z'),
    });
    const secondSupport = await defect(actId, 'filter-second', {
      orgId: ownOrgId,
      workTypeId: workType.id,
      createdAt: new Date('2026-04-16T00:00:00.000Z'),
    });
    const otherObjectDefect = await defect(otherAct.id, 'filter-object', {
      orgId: ownOrgId,
      createdAt: new Date('2026-04-12T00:00:00.000Z'),
    });
    const otherOrgDefect = await defect(actId, 'filter-org', {
      orgId: foreignOrgId,
      workTypeId: workType.id,
      createdAt: new Date('2026-04-11T00:00:00.000Z'),
    });
    const completed = await defect(actId, 'filter-completed', {
      orgId: ownOrgId,
      status: 'COMPLETED',
      workTypeId: workType.id,
      createdAt: new Date('2026-04-18T00:00:00.000Z'),
    });
    async function insight(
      key: string,
      defectIds: string[],
      scope: {
        kind: 'COMPANY' | 'ORGANIZATION' | 'ASSIGNED';
        fingerprint: string;
        userId?: string;
      },
      options: { supportAvailable?: boolean; status?: 'NEW' | 'CONFIRMED' } = {},
    ) {
      return prisma.analyticsInsight.create({
        data: {
          signalKey: `${marker}:${key}`,
          signalType: 'DATA_QUALITY_RISK',
          title: key,
          plainLanguageExplanation: marker,
          dimensions: [],
          supportCount: defectIds.length,
          totalCount: Math.max(defectIds.length, 1),
          observedValue: '1',
          baselineValue: '1',
          confidence: 'low',
          generatedAt: new Date('2026-04-11T00:00:00.000Z'),
          ruleVersion: '2026.10.05.2',
          scopeKind: scope.kind,
          scopeFingerprint: scope.fingerprint,
          scopeUserId: scope.userId,
          filterHash: 'not-a-current-filter',
          snapshotHash: `${marker}:${key}`,
          supportAvailable: options.supportAvailable ?? true,
          status: options.status ?? 'NEW',
          defects: {
            create: defectIds.map((defectItemId) => ({
              defectItemId,
              contributionReason: 'пересечение фильтра',
              observedAt: new Date('2026-04-11T00:00:00.000Z'),
            })),
          },
        },
      });
    }
    const shared = await insight('shared', [primary.id, secondSupport.id], {
      kind: 'COMPANY',
      fingerprint: 'company',
    });
    const objectInsight = await insight('object', [otherObjectDefect.id], {
      kind: 'COMPANY',
      fingerprint: 'company',
    });
    const orgInsight = await insight('org', [otherOrgDefect.id], {
      kind: 'COMPANY',
      fingerprint: 'company',
    });
    const completedInsight = await insight('completed', [completed.id], {
      kind: 'COMPANY',
      fingerprint: 'company',
    });
    await insight(
      'legacy',
      [],
      { kind: 'COMPANY', fingerprint: 'company' },
      { supportAvailable: false },
    );
    await insight('foreign-scope', [primary.id], {
      kind: 'ORGANIZATION',
      fingerprint: `org:${foreignOrgId}`,
    });
    await insight('contractor-foreign', [otherOrgDefect.id], {
      kind: 'ORGANIZATION',
      fingerprint: `org:${ownOrgId}`,
    });
    await insight('assigned-hidden', [otherObjectDefect.id], {
      kind: 'ASSIGNED',
      fingerprint: `user:${responsible.id}`,
      userId: responsible.id,
    });
    await prisma.$executeRaw`ALTER TABLE public.defect_items DROP CONSTRAINT IF EXISTS defect_items_ready_not_before_created`;
    const reversed = await prisma.defectItem.create({
      data: {
        actId,
        defectTypeId,
        status: 'COMPLETED',
        location: 'reversed-duration',
        claimDetails: 'reversed-duration',
        createdAt: new Date('2026-04-10T00:00:00.000Z'),
        readyAt: new Date('2026-04-01T00:00:00.000Z'),
      },
    });
    await prisma.$executeRaw`
      ALTER TABLE public.defect_items
      ADD CONSTRAINT defect_items_ready_not_before_created
      CHECK ("readyAt" IS NULL OR "readyAt" >= "createdAt") NOT VALID
    `;

    const adminSession = await login(admin.email);
    const oneDay = (
      await read(adminSession, '/api/analytics/overview?dateFrom=2026-04-16&dateTo=2026-04-16')
    ).json() as { newInsights: number };
    const oneDayPatterns = (
      await read(adminSession, '/api/analytics/patterns?dateFrom=2026-04-16&dateTo=2026-04-16')
    ).json() as { items: Array<{ status: string }> };
    expect(oneDay.newInsights).toBe(
      oneDayPatterns.items.filter((item) => item.status === 'NEW').length,
    );
    expect(oneDay.newInsights).toBe(1);
    const combined = (
      await read(
        adminSession,
        `/api/analytics/overview?dateFrom=2026-04-01&dateTo=2026-04-30&propertyObjectId=${objectId}&liableOrganizationId=${ownOrgId}&defectTypeId=${defectTypeId}&workTypeId=${workType.id}&status=IN_PROGRESS`,
      )
    ).json() as { newInsights: number };
    expect(combined.newInsights).toBe(1);
    const april = '/api/analytics/overview?dateFrom=2026-04-01&dateTo=2026-04-30';
    const aprilBody = (await read(adminSession, april)).json() as {
      newInsights: number;
      medianClosureMs: number | null;
      p90ClosureMs: number | null;
    };
    const aprilPatterns = (
      await read(adminSession, '/api/analytics/patterns?dateFrom=2026-04-01&dateTo=2026-04-30')
    ).json() as { items: Array<{ id: string; status: string }> };
    expect(aprilPatterns.items.filter((item) => item.status === 'NEW').length).toBe(
      aprilBody.newInsights,
    );
    expect(aprilBody.newInsights).toBeGreaterThanOrEqual(4);
    const empty = (
      await read(adminSession, '/api/analytics/overview?dateFrom=2099-01-01&dateTo=2099-01-02')
    ).json() as { newInsights: number };
    const emptyPatterns = (
      await read(adminSession, '/api/analytics/patterns?dateFrom=2099-01-01&dateTo=2099-01-02')
    ).json() as { items: unknown[] };
    expect(empty.newInsights).toBe(0);
    expect(emptyPatterns.items).toEqual([]);
    const period = 'dateFrom=2026-04-01&dateTo=2026-04-30';
    async function newSignalIds(query: string) {
      const overview = (await read(adminSession, `/api/analytics/overview?${query}`)).json() as {
        newInsights: number;
      };
      const patterns = (await read(adminSession, `/api/analytics/patterns?${query}`)).json() as {
        items: Array<{ id: string; status: string }>;
      };
      const ids = patterns.items.filter((item) => item.status === 'NEW').map((item) => item.id);
      expect(ids.length).toBe(overview.newInsights);
      return ids;
    }
    const objectIds = await newSignalIds(`${period}&propertyObjectId=${objectId}`);
    const otherObjectIds = await newSignalIds(`${period}&propertyObjectId=${otherObject.id}`);
    expect(objectIds).toContain(shared.id);
    expect(objectIds).not.toContain(objectInsight.id);
    expect(otherObjectIds).toContain(objectInsight.id);
    expect(otherObjectIds).not.toContain(shared.id);
    const orgIds = await newSignalIds(`${period}&liableOrganizationId=${ownOrgId}`);
    const foreignOrgIds = await newSignalIds(`${period}&liableOrganizationId=${foreignOrgId}`);
    expect(orgIds).toContain(shared.id);
    expect(orgIds).not.toContain(orgInsight.id);
    expect(foreignOrgIds).toContain(orgInsight.id);
    expect(foreignOrgIds).not.toContain(shared.id);
    const typeIds = await newSignalIds(`${period}&defectTypeId=${defectTypeId}`);
    expect(typeIds).toContain(shared.id);
    const absentType = await prisma.defectType.create({
      data: { code: `${marker}-other`, name: `${marker} other type`, sortOrder: 92 },
    });
    expect(await newSignalIds(`${period}&defectTypeId=${absentType.id}`)).toEqual([]);
    await prisma.defectType.delete({ where: { id: absentType.id } });
    const workIds = await newSignalIds(`${period}&workTypeId=${workType.id}`);
    expect(workIds).toContain(shared.id);
    expect(workIds).not.toContain(objectInsight.id);
    const completedIds = await newSignalIds(`${period}&status=COMPLETED`);
    const progressIds = await newSignalIds(`${period}&status=IN_PROGRESS`);
    expect(completedIds).toContain(completedInsight.id);
    expect(completedIds).not.toContain(shared.id);
    expect(progressIds).toContain(shared.id);
    expect(progressIds).not.toContain(completedInsight.id);
    const unfiltered = (await read(adminSession, '/api/analytics/overview')).json() as {
      newInsights: number;
      medianClosureMs: number | null;
      p90ClosureMs: number | null;
    };
    expect(unfiltered.newInsights).toBeGreaterThanOrEqual(aprilBody.newInsights);
    expect(unfiltered.medianClosureMs == null || unfiltered.medianClosureMs >= 0).toBe(true);
    expect(unfiltered.p90ClosureMs == null || unfiltered.p90ClosureMs >= 0).toBe(true);
    const quality = (
      await read(adminSession, '/api/analytics/data-quality?dateFrom=2026-04-01&dateTo=2026-04-30')
    ).json() as {
      invalidTemporalRecords: number;
      coverage: Array<{ metric: string; covered: number; total: number }>;
    };
    expect(quality.invalidTemporalRecords).toBeGreaterThan(0);
    const temporal = quality.coverage.find((item) => item.metric === 'temporalOrder');
    expect(temporal?.covered).toBe(temporal!.total - quality.invalidTemporalRecords);
    const drill = (
      await read(
        adminSession,
        '/api/analytics/drilldown?metric=invalidTemporal&dateFrom=2026-04-01&dateTo=2026-04-30',
      )
    ).json() as { items: Array<{ label?: string; location?: string }> };
    expect(JSON.stringify(drill)).toContain(reversed.id);
    const process = (await read(adminSession, '/api/analytics/process')).json() as {
      contractor: { median: number | null; mean: number | null };
      inspection: { median: number | null };
      rework: { median: number | null };
      total: { median: number | null; mean: number | null };
    };
    for (const value of [
      process.contractor.median,
      process.contractor.mean,
      process.inspection.median,
      process.rework.median,
      process.total.median,
      process.total.mean,
    ]) {
      expect(value == null || value >= 0).toBe(true);
    }
    const contractorSession = await login(contractor.email);
    expect(
      (
        await read(
          contractorSession,
          '/api/analytics/overview?dateFrom=2026-04-01&dateTo=2026-04-30',
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await read(
          contractorSession,
          '/api/analytics/patterns?dateFrom=2026-04-01&dateTo=2026-04-30',
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await read(
          await login(responsible.email),
          `/api/analytics/overview?dateFrom=2026-04-01&dateTo=2026-04-30&propertyObjectId=${otherObject.id}`,
        )
      ).statusCode,
    ).toBe(403);
    await prisma.analyticsInsightDefect.deleteMany({
      where: {
        OR: [
          { insight: { snapshotHash: { startsWith: `${marker}:` } } },
          { defectItemId: reversed.id },
          {
            defectItem: {
              location: {
                in: [
                  'filter-primary',
                  'filter-second',
                  'filter-object',
                  'filter-org',
                  'filter-completed',
                ],
              },
            },
          },
        ],
      },
    });
    await prisma.analyticsInsight.deleteMany({
      where: { snapshotHash: { startsWith: `${marker}:` } },
    });
    await prisma.defectItemLiableOrganization.deleteMany({
      where: {
        defectItem: { actId: { in: [actId, otherAct.id] }, location: { startsWith: 'filter-' } },
      },
    });
    await prisma.defectItem.deleteMany({ where: { id: reversed.id } });
    await prisma.defectItem.deleteMany({
      where: {
        location: {
          in: [
            'filter-primary',
            'filter-second',
            'filter-object',
            'filter-org',
            'filter-completed',
          ],
        },
      },
    });
    await prisma.act.deleteMany({ where: { id: otherAct.id } });
    await prisma.propertyObject.deleteMany({ where: { id: otherObject.id } });
    await prisma.workType.deleteMany({ where: { id: workType.id } });
  });
});
