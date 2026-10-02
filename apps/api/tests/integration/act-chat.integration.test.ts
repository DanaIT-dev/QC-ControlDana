import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from '@sgr-registry/config';
import {
  createOwnerPrismaClient,
  createPrismaClient,
  disconnectPrismaClient,
  upsertUserCredentials,
  withAuthenticatedDbContext,
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
let appPrisma: PrismaClient;
let redis: Redis;
const createdUserIds: string[] = [];
const createdActIds: string[] = [];

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
  cookies: Array<{ name: string; value: string }>;
}

async function inject(opts: {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
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
      'x-request-id': `chat-${Date.now()}-${Math.random()}`,
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(
  role: UserRole,
  extras: { fullName?: string; status?: 'ACTIVE' | 'ARCHIVED' } = {},
) {
  const email = `chat.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: {
      ...personNameWriteFields(extras.fullName ?? `Чат ${role}`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
      email,
      role,
      status: extras.status ?? 'ACTIVE',
      mustChangePassword: false,
      archivedAt: extras.status === 'ARCHIVED' ? new Date() : null,
    },
  });
  await upsertUserCredentials(prisma, { userId: user.id, passwordHash });
  createdUserIds.push(user.id);
  return user;
}

async function login(email: string) {
  const response = await inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: DEMO_PASSWORD },
  });
  const body = response.json() as { csrfToken: string; id: string };
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value ?? '';
  return { response, body, cookie };
}

async function mutate(
  session: { cookie: string; body: { csrfToken: string } },
  opts: {
    method: 'POST' | 'PATCH';
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  },
) {
  return inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload ?? {},
    cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    headers: { [CSRF_HEADER_NAME]: session.body.csrfToken, ...opts.headers },
  });
}

async function read(session: { cookie: string }, url: string) {
  return inject({
    method: 'GET',
    url,
    cookies: { [SESSION_COOKIE_NAME]: session.cookie },
  });
}

async function catalogs() {
  const suffix = Math.random().toString(16).slice(2, 8);
  const object = await prisma.propertyObject.create({
    data: { name: `Чат-объект ${suffix}`, address: 'Минск' },
  });
  const customer = await prisma.organization.create({
    data: {
      officialName: `Чат-заказчик ${suffix}`,
      postalAddress: 'addr',
      email: `chat-cust-${suffix}@example.sgr.local`,
      phone: '1',
      contactPerson: 'К',
      roles: { create: [{ role: 'CUSTOMER' }] },
    },
  });
  const liable = await prisma.organization.create({
    data: {
      officialName: `Чат-подрядчик ${suffix}`,
      postalAddress: 'addr',
      email: `chat-liable-${suffix}@example.sgr.local`,
      phone: '1',
      contactPerson: 'П',
      roles: { create: [{ role: 'LIABLE_CONTRACTOR' }] },
    },
  });
  const defectType = await prisma.defectType.create({
    data: { code: `CHAT-${suffix}`, name: `Чат-дефект ${suffix}`, sortOrder: 80 },
  });
  return { object, customer, liable, defectType };
}

async function createAct(
  session: { cookie: string; body: { csrfToken: string } },
  input: {
    objectId: string;
    customerId: string;
    defectTypeId: string;
    engineerId: string;
    liableId: string;
    location?: string;
  },
) {
  const response = await mutate(session, {
    method: 'POST',
    url: '/api/acts',
    payload: {
      formCode: 'S1',
      objectId: input.objectId,
      customerOrganizationId: input.customerId,
      issuedOn: '2026-08-20',
      defectItems: [
        {
          location: input.location ?? 'Кв. чат',
          defectTypeId: input.defectTypeId,
          claimDetails: 'Описание',
          responsibleEngineerIds: [input.engineerId],
          liableOrganizationIds: [input.liableId],
        },
      ],
    },
    headers: { 'idempotency-key': randomUUID() },
  });
  const body = response.json() as { id?: string };
  if (typeof body.id === 'string') {
    createdActIds.push(body.id);
  }
  return { response, id: body.id };
}

describe('act chat integration', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.REDIS_KEY_PREFIX = 'sgr-test';
    const config = loadConfig();
    prisma = createOwnerPrismaClient(config.MIGRATION_DATABASE_URL);
    appPrisma = createPrismaClient(config.DATABASE_URL);
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
      await prisma.actChatMention.deleteMany({
        where: { message: { actId: { in: actIds } } },
      });
      await prisma.actChatMessage.deleteMany({ where: { actId: { in: actIds } } });
      await prisma.slaClock.deleteMany({ where: { defectItem: { actId: { in: actIds } } } });
      await prisma.proposal.deleteMany({ where: { defectItem: { actId: { in: actIds } } } });
      await prisma.defectItemEngineer.deleteMany({
        where: { defectItem: { actId: { in: actIds } } },
      });
      await prisma.defectItemLiableOrganization.deleteMany({
        where: { defectItem: { actId: { in: actIds } } },
      });
      await prisma.defectItem.deleteMany({ where: { actId: { in: actIds } } });
      await prisma.act.deleteMany({ where: { id: { in: actIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.propertyObjectEngineer.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.idempotencyRecord.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
      await prisma.auditLog
        .deleteMany({ where: { actorUserId: { in: createdUserIds } } })
        .catch(() => undefined);
      await prisma.user
        .deleteMany({ where: { id: { in: createdUserIds } } })
        .catch(() => undefined);
    }
    await app.close();
    await redis.quit();
    await appPrisma.$disconnect();
    await disconnectPrismaClient();
  });

  it('enforces role access, unassign, 401/403/404 and authorId spoofing', async () => {
    const admin = await createUser('ADMIN');
    const manager = await createUser('SGR_MANAGER');
    const responsible = await createUser('RESPONSIBLE_ENGINEER', { fullName: 'Инженер Север' });
    const foreign = await createUser('RESPONSIBLE_ENGINEER', { fullName: 'Инженер Чужой' });
    const contractor = await createUser('CONTRACTOR_ENGINEER');
    const adminSession = await login(admin.email);
    const managerSession = await login(manager.email);
    const responsibleSession = await login(responsible.email);
    const contractorSession = await login(contractor.email);
    const own = await catalogs();
    const other = await catalogs();
    await prisma.propertyObjectEngineer.create({
      data: { propertyObjectId: own.object.id, userId: responsible.id },
    });
    await prisma.propertyObjectEngineer.create({
      data: { propertyObjectId: other.object.id, userId: foreign.id },
    });
    const created = await createAct(adminSession, {
      objectId: own.object.id,
      customerId: own.customer.id,
      defectTypeId: own.defectType.id,
      engineerId: responsible.id,
      liableId: own.liable.id,
    });
    expect(created.response.statusCode).toBe(201);
    const actId = created.id!;
    const foreignAct = await createAct(adminSession, {
      objectId: other.object.id,
      customerId: other.customer.id,
      defectTypeId: other.defectType.id,
      engineerId: foreign.id,
      liableId: other.liable.id,
    });
    const foreignActId = foreignAct.id!;

    const unauth = await inject({ method: 'GET', url: `/api/acts/${actId}/chat` });
    expect(unauth.statusCode).toBe(401);

    const contractorGet = await read(contractorSession, `/api/acts/${actId}/chat`);
    expect(contractorGet.statusCode).toBe(403);
    expect(JSON.stringify(contractorGet.json())).not.toMatch(/items|Обсуждение|body/);
    expect(
      (await read(contractorSession, `/api/acts/${actId}/chat/mention-candidates`)).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate(contractorSession, {
          method: 'POST',
          url: `/api/acts/${actId}/chat`,
          payload: { body: 'нет', clientMessageId: randomUUID() },
        })
      ).statusCode,
    ).toBe(403);

    const adminPost = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${actId}/chat`,
      payload: { body: 'Сообщение администратора', clientMessageId: randomUUID() },
    });
    expect(adminPost.statusCode).toBe(201);
    const managerPost = await mutate(managerSession, {
      method: 'POST',
      url: `/api/acts/${actId}/chat`,
      payload: { body: 'Сообщение руководителя', clientMessageId: randomUUID() },
    });
    expect(managerPost.statusCode).toBe(201);
    const responsiblePost = await mutate(responsibleSession, {
      method: 'POST',
      url: `/api/acts/${actId}/chat`,
      payload: { body: 'Сообщение инженера', clientMessageId: randomUUID() },
    });
    expect(responsiblePost.statusCode).toBe(201);
    expect((await read(adminSession, `/api/acts/${actId}/chat`)).statusCode).toBe(200);
    expect((await read(managerSession, `/api/acts/${actId}/chat`)).statusCode).toBe(200);
    expect((await read(responsibleSession, `/api/acts/${actId}/chat`)).statusCode).toBe(200);

    const foreignChat = await read(responsibleSession, `/api/acts/${foreignActId}/chat`);
    expect(foreignChat.statusCode).toBe(404);
    expect(JSON.stringify(foreignChat.json())).not.toContain(foreignActId);

    const missing = await read(adminSession, `/api/acts/${randomUUID()}/chat`);
    expect(missing.statusCode).toBe(404);

    const spoof = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${actId}/chat`,
      payload: {
        body: 'подмена',
        clientMessageId: randomUUID(),
        authorId: contractor.id,
      },
    });
    expect(spoof.statusCode).toBe(400);

    await prisma.propertyObjectEngineer.update({
      where: {
        propertyObjectId_userId: { propertyObjectId: own.object.id, userId: responsible.id },
      },
      data: { unassignedAt: new Date() },
    });
    expect((await read(responsibleSession, `/api/acts/${actId}/chat`)).statusCode).toBe(404);
    await prisma.propertyObjectEngineer.update({
      where: {
        propertyObjectId_userId: { propertyObjectId: own.object.id, userId: responsible.id },
      },
      data: { unassignedAt: null },
    });
    expect((await read(responsibleSession, `/api/acts/${actId}/chat`)).statusCode).toBe(200);
    const restored = await read(responsibleSession, `/api/acts/${actId}/chat`);
    const restoredBody = restored.json() as { items: Array<{ body: string }> };
    expect(restoredBody.items.some((item) => item.body === 'Сообщение инженера')).toBe(true);
  });

  it('validates mentions, notifications, idempotency and never creates SMTP', async () => {
    const admin = await createUser('ADMIN', { fullName: 'Админ Чата' });
    const responsible = await createUser('RESPONSIBLE_ENGINEER', { fullName: 'Инженер Чата' });
    const foreign = await createUser('RESPONSIBLE_ENGINEER', { fullName: 'Чужой Инженер Чата' });
    const contractor = await createUser('CONTRACTOR_ENGINEER', { fullName: 'Подрядчик Чата' });
    const adminSession = await login(admin.email);
    const responsibleSession = await login(responsible.email);
    const own = await catalogs();
    const other = await catalogs();
    await prisma.propertyObjectEngineer.create({
      data: { propertyObjectId: own.object.id, userId: responsible.id },
    });
    await prisma.propertyObjectEngineer.create({
      data: { propertyObjectId: other.object.id, userId: foreign.id },
    });
    const created = await createAct(adminSession, {
      objectId: own.object.id,
      customerId: own.customer.id,
      defectTypeId: own.defectType.id,
      engineerId: responsible.id,
      liableId: own.liable.id,
    });
    const actId = created.id!;
    const clientMessageId = randomUUID();
    const xss = '<script>alert(1)</script> @Инженер Чата';
    const posted = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${actId}/chat`,
      payload: {
        body: xss,
        clientMessageId,
        mentionedUserIds: [
          responsible.id,
          responsible.id,
          admin.id,
          contractor.id,
          foreign.id,
          randomUUID(),
        ],
      },
    });
    expect(posted.statusCode).toBe(201);
    const message = posted.json() as {
      id: string;
      body: string;
      author: { id: string; email?: string };
      mentions: Array<{ userId: string }>;
    };
    expect(message.body).toContain('<script>alert(1)</script>');
    expect(message.author.id).toBe(admin.id);
    expect(message.author).not.toHaveProperty('email');
    expect(message.mentions.map((item) => item.userId).sort()).toEqual(
      [admin.id, responsible.id].sort(),
    );

    const retry = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${actId}/chat`,
      payload: {
        body: xss,
        clientMessageId,
        mentionedUserIds: [responsible.id],
      },
    });
    expect(retry.statusCode).toBe(201);
    expect((retry.json() as { id: string }).id).toBe(message.id);

    const events = await prisma.notificationEvent.findMany({
      where: { actId, type: 'ACT_CHAT_MENTION' },
      include: { recipients: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.recipients).toHaveLength(1);
    expect(events[0]?.recipients[0]?.userId).toBe(responsible.id);
    expect(JSON.stringify(events[0]?.payload)).not.toMatch(/proposalB|amountB/);

    const inbox = await read(responsibleSession, '/api/notifications?filter=unread');
    expect(inbox.statusCode).toBe(200);
    const items = (inbox.json() as { items: Array<{ type: string; body: string; actId: string }> })
      .items;
    expect(items.some((item) => item.type === 'ACT_CHAT_MENTION' && item.actId === actId)).toBe(
      true,
    );

    const self = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${actId}/chat`,
      payload: {
        body: 'Сам себе @Админ Чата',
        clientMessageId: randomUUID(),
        mentionedUserIds: [admin.id],
      },
    });
    expect(self.statusCode).toBe(201);
    const afterSelf = await prisma.notificationEvent.count({
      where: { actId, type: 'ACT_CHAT_MENTION' },
    });
    expect(afterSelf).toBe(1);

    const engineerMention = await mutate(responsibleSession, {
      method: 'POST',
      url: `/api/acts/${actId}/chat`,
      payload: {
        body: '@Админ Чата проверка упоминания',
        clientMessageId: randomUUID(),
        mentionedUserIds: [admin.id],
      },
    });
    expect(engineerMention.statusCode).toBe(201);
    const mentionEvents = await prisma.notificationEvent.findMany({
      where: { actId, type: 'ACT_CHAT_MENTION' },
      include: { recipients: true },
    });
    expect(mentionEvents).toHaveLength(2);
    expect(
      mentionEvents.some((event) => event.recipients.some((row) => row.userId === admin.id)),
    ).toBe(true);

    const outboxHits = await prisma.outboxEvent.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 60_000) } },
    });
    expect(
      outboxHits.filter((row) => JSON.stringify(row.payload).includes('ACT_CHAT_MENTION')),
    ).toHaveLength(0);
    const deliveries = await prisma.emailDelivery.count({
      where: { recipient: { event: { actId, type: 'ACT_CHAT_MENTION' } } },
    });
    expect(deliveries).toBe(0);

    const candidates = await read(
      adminSession,
      `/api/acts/${actId}/chat/mention-candidates?q=${encodeURIComponent('Чужой')}`,
    );
    expect(candidates.statusCode).toBe(200);
    const candidateIds = (
      candidates.json() as { items: Array<{ id: string; fullName: string }> }
    ).items.map((item) => item.id);
    expect(candidateIds).not.toContain(foreign.id);
    expect(candidateIds).not.toContain(contractor.id);

    const audit = await prisma.auditLog.findMany({
      where: { action: 'ACT_CHAT_MESSAGE_CREATED', parentEntityId: actId },
    });
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain('<script>');
  });

  it('paginates by keyset and accepts concurrent distinct messages', async () => {
    const admin = await createUser('ADMIN');
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const adminSession = await login(admin.email);
    const { object, customer, liable, defectType } = await catalogs();
    await prisma.propertyObjectEngineer.create({
      data: { propertyObjectId: object.id, userId: engineer.id },
    });
    const created = await createAct(adminSession, {
      objectId: object.id,
      customerId: customer.id,
      defectTypeId: defectType.id,
      engineerId: engineer.id,
      liableId: liable.id,
    });
    const actId = created.id!;
    for (let index = 0; index < 35; index += 1) {
      const response = await mutate(adminSession, {
        method: 'POST',
        url: `/api/acts/${actId}/chat`,
        payload: {
          body: `Сообщение ${String(index).padStart(2, '0')}`,
          clientMessageId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(201);
    }
    const first = await read(adminSession, `/api/acts/${actId}/chat`);
    const firstBody = first.json() as {
      items: Array<{ id: string; body: string }>;
      hasOlder: boolean;
      olderCursor: string | null;
    };
    expect(firstBody.items).toHaveLength(30);
    expect(firstBody.hasOlder).toBe(true);
    expect(firstBody.items[0]?.body).toBe('Сообщение 05');
    expect(firstBody.items[29]?.body).toBe('Сообщение 34');
    const older = await read(
      adminSession,
      `/api/acts/${actId}/chat?before=${encodeURIComponent(firstBody.olderCursor ?? '')}`,
    );
    const olderBody = older.json() as {
      items: Array<{ id: string; body: string }>;
      hasOlder: boolean;
    };
    expect(olderBody.items).toHaveLength(5);
    expect(olderBody.hasOlder).toBe(false);
    const overlap = olderBody.items.filter((item) =>
      firstBody.items.some((current) => current.id === item.id),
    );
    expect(overlap).toHaveLength(0);
    expect([...olderBody.items, ...firstBody.items].map((item) => item.body)).toEqual(
      Array.from({ length: 35 }, (_, index) => `Сообщение ${String(index).padStart(2, '0')}`),
    );

    const [left, right] = await Promise.all([
      mutate(adminSession, {
        method: 'POST',
        url: `/api/acts/${actId}/chat`,
        payload: { body: 'Параллель A', clientMessageId: randomUUID() },
      }),
      mutate(adminSession, {
        method: 'POST',
        url: `/api/acts/${actId}/chat`,
        payload: { body: 'Параллель B', clientMessageId: randomUUID() },
      }),
    ]);
    expect(left.statusCode).toBe(201);
    expect(right.statusCode).toBe(201);
    expect((left.json() as { id: string }).id).not.toBe((right.json() as { id: string }).id);
  });

  it('rejects chat mutations without RLS context and rolls back on error', async () => {
    const admin = await createUser('ADMIN');
    const engineer = await createUser('RESPONSIBLE_ENGINEER');
    const adminSession = await login(admin.email);
    const { object, customer, liable, defectType } = await catalogs();
    await prisma.propertyObjectEngineer.create({
      data: { propertyObjectId: object.id, userId: engineer.id },
    });
    const created = await createAct(adminSession, {
      objectId: object.id,
      customerId: customer.id,
      defectTypeId: defectType.id,
      engineerId: engineer.id,
      liableId: liable.id,
    });
    const actId = created.id!;
    const seed = await mutate(adminSession, {
      method: 'POST',
      url: `/api/acts/${actId}/chat`,
      payload: { body: 'Контекст', clientMessageId: randomUUID() },
    });
    expect(seed.statusCode).toBe(201);
    const messageId = (seed.json() as { id: string }).id;
    const open = await appPrisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM act_chat_messages WHERE id = ${messageId}::uuid
    `;
    expect(open).toHaveLength(0);
    try {
      const patched = await appPrisma.$executeRaw`
        UPDATE act_chat_messages SET body = ${'nope'} WHERE id = ${messageId}::uuid
      `;
      expect(patched).toBe(0);
    } catch (error) {
      expect(String(error)).toMatch(/permission denied|42501|row-level security/i);
    }

    const clientMessageId = randomUUID();
    await expect(
      withAuthenticatedDbContext({
        prisma: appPrisma,
        secret: loadConfig().RLS_CONTEXT_SECRET,
        user: { id: admin.id, sessionVersion: 1 },
        callback: async (tx) => {
          await tx.actChatMessage.create({
            data: {
              actId,
              authorId: admin.id,
              body: 'Будет откат',
              clientMessageId,
            },
          });
          throw new Error('forced-chat-fail');
        },
      }),
    ).rejects.toThrow('forced-chat-fail');
    const leftover = await prisma.actChatMessage.findMany({ where: { clientMessageId } });
    expect(leftover).toHaveLength(0);

    await withAuthenticatedDbContext({
      prisma: appPrisma,
      secret: loadConfig().RLS_CONTEXT_SECRET,
      user: { id: admin.id, sessionVersion: 1 },
      callback: async (tx) =>
        Promise.all([
          tx.actChatMessage.findMany({ where: { actId } }),
          tx.act.findMany({ where: { id: actId } }),
        ]),
    });
  });
});
