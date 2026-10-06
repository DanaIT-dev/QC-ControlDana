import { createServer, createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { loadConfig } from '@sgr-registry/config';
import {
  createOwnerPrismaClient,
  createPrismaClient,
  disconnectPrismaClient,
  prismaWithRlsTransaction,
  type PrismaClient,
  withWorkerDbContext,
} from '@sgr-registry/database';
import {
  EMAIL_DELIVER_JOB,
  PREVIOUS_RLS_TX_TIMEOUT_MS,
  emailJobId,
  emailMessageId,
  CONFIRMED_LAST_FIRST_TOKEN_ORDER,
  personNameWriteFields,
} from '@sgr-registry/domain';
import { NotificationDispatcher, NOTIFICATION_QUEUE } from '@sgr-registry/jobs';
import { startWorkerRuntime, type WorkerRuntime } from '../../../worker/src/runtime';

type FakeSmtp = {
  host: string;
  port: number;
  close: () => Promise<void>;
};

async function startFakeSmtp(options: {
  hangAfterConnect?: boolean;
  dataDelayMs?: number;
  dataReply?: string;
}): Promise<FakeSmtp> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      if (options.hangAfterConnect) {
        return;
      }
      let buffer = '';
      let inData = false;
      const send = (line: string) => {
        socket.write(`${line}\r\n`);
      };
      send('220 fake-smtp ESMTP');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (inData) {
          if (buffer.includes('\r\n.\r\n')) {
            inData = false;
            buffer = '';
            const reply = options.dataReply ?? '250 2.0.0 Ok: queued';
            setTimeout(() => send(reply), options.dataDelayMs ?? 0);
          }
          return;
        }
        const lines = buffer.split(/\r\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const command = line.split(' ')[0]?.toUpperCase() ?? '';
          if (command === 'EHLO' || command === 'HELO') {
            send('250-localhost');
            send('250 AUTH PLAIN');
          } else if (
            command === 'MAIL' ||
            command === 'RCPT' ||
            command === 'RSET' ||
            command === 'NOOP'
          ) {
            send('250 2.1.0 Ok');
          } else if (command === 'DATA') {
            inData = true;
            send('354 End data with <CR><LF>.<CR><LF>');
          } else if (command === 'QUIT') {
            send('221 2.0.0 Bye');
            socket.end();
          } else {
            send('250 2.0.0 Ok');
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fake smtp bind failed'));
        return;
      }
      resolve({
        host: '127.0.0.1',
        port: address.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

async function waitForSmtpGreeting(host: string, port: number): Promise<void> {
  const deadline = Date.now() + 40_000;
  let lastError: unknown = new Error('Mailpit SMTP is not ready');
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host, port, family: 4 });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`smtp greeting timeout on ${host}:${port}`));
        }, 8_000);
        socket.once('data', (chunk) => {
          clearTimeout(timer);
          const text = chunk.toString('utf8');
          if (text.startsWith('220')) {
            socket.write('QUIT\r\n');
            socket.destroy();
            resolve();
            return;
          }
          socket.destroy();
          reject(new Error(`unexpected smtp greeting: ${text.slice(0, 80)}`));
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  }
  throw lastError;
}

async function mailpitHeaders(email: string): Promise<string[]> {
  const config = loadConfig();
  const query = encodeURIComponent(`to:${email}`);
  const search = await fetch(`${config.MAILPIT_API_URL}/api/v1/search?query=${query}`);
  const body = (await search.json()) as { messages?: Array<{ ID: string; MessageID?: string }> };
  const ids = (body.messages ?? []).map((item) => item.ID);
  const headers: string[] = [];
  for (const id of ids) {
    const message = await fetch(`${config.MAILPIT_API_URL}/api/v1/message/${id}`);
    const payload = (await message.json()) as {
      MessageID?: string;
      Headers?: Record<string, string[] | string>;
    };
    const header = payload.Headers?.['Message-Id'] ?? payload.Headers?.['Message-ID'];
    const value = Array.isArray(header) ? header[0] : (header ?? payload.MessageID ?? '');
    if (value) {
      headers.push(value);
    }
  }
  return headers;
}

describe('notification worker SMTP lifecycle', () => {
  let prisma: PrismaClient;
  let workerPrisma: PrismaClient;
  let queue: Queue;
  let dispatcher: NotificationDispatcher;
  const createdUserIds: string[] = [];
  const previousSmtp = {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    timeout: process.env.SMTP_TIMEOUT_MS,
  };

  function restoreSmtpEnv(): void {
    restoreEnv('SMTP_HOST', previousSmtp.host);
    restoreEnv('SMTP_PORT', previousSmtp.port);
    restoreEnv('SMTP_TIMEOUT_MS', previousSmtp.timeout);
  }

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const config = loadConfig();
    const mailpit = await fetch(`${config.MAILPIT_API_URL}/api/v1/info`);
    if (!mailpit.ok) {
      throw new Error(`Mailpit is not reachable at ${config.MAILPIT_API_URL}`);
    }
    await waitForSmtpGreeting(config.SMTP_HOST, config.SMTP_PORT);
    prisma = createOwnerPrismaClient(config.MIGRATION_DATABASE_URL);
    workerPrisma = createPrismaClient(config.WORKER_DATABASE_URL);
    queue = new Queue(NOTIFICATION_QUEUE, {
      connection: { url: config.REDIS_URL, maxRetriesPerRequest: null },
    });
    dispatcher = new NotificationDispatcher(prisma, queue);
    await prisma.systemSettings.upsert({
      where: { id: 'default' },
      update: {},
      create: { id: 'default', deadlineWarningDays: 3 },
    });
  });

  afterEach(() => {
    restoreSmtpEnv();
  });

  afterAll(async () => {
    restoreSmtpEnv();
    if (createdUserIds.length > 0) {
      await prisma.emailDelivery.deleteMany({
        where: { recipient: { userId: { in: createdUserIds } } },
      });
      await prisma.notificationRecipient.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user
        .deleteMany({ where: { id: { in: createdUserIds } } })
        .catch(() => undefined);
    }
    await queue?.close();
    await workerPrisma?.$disconnect();
    await prisma?.$disconnect();
    await disconnectPrismaClient();
  });

  async function idleInTransactionCount(): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'idle in transaction'
        AND pid <> pg_backend_pid()
    `;
    return rows[0]?.n ?? 0;
  }

  async function createDeliveryFixture() {
    const suffix = Math.random().toString(16).slice(2, 10);
    const user = await prisma.user.create({
      data: {
        ...personNameWriteFields(`SMTP ${suffix}`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
        email: `smtp.${suffix}@example.sgr.local`,
        role: 'RESPONSIBLE_ENGINEER',
      },
    });
    createdUserIds.push(user.id);
    const object = await prisma.propertyObject.create({
      data: { name: `SMTP object ${suffix}`, address: 'Минск' },
    });
    const org = await prisma.organization.create({
      data: {
        officialName: `SMTP org ${suffix}`,
        postalAddress: 'addr',
        email: `smtp-org-${suffix}@example.sgr.local`,
        phone: '1',
        contactPerson: 'S',
      },
    });
    const seq = Math.floor(Math.random() * 800_000) + 100_000;
    const act = await prisma.act.create({
      data: {
        officialNumber: `SMTP-${suffix}`,
        formCode: 'S1',
        year: 2099,
        sequence: seq,
        objectId: object.id,
        customerOrganizationId: org.id,
        issuedOn: new Date('2026-01-15T12:00:00.000Z'),
        status: 'IN_PROGRESS',
        createdAt: new Date('2026-01-15T12:00:00.000Z'),
        startedAt: new Date('2026-01-15T12:00:00.000Z'),
      },
    });
    const defectType = await prisma.defectType.upsert({
      where: { code: 'SMTP_TEST' },
      update: {},
      create: { code: 'SMTP_TEST', name: 'SMTP test', sortOrder: 902, active: true },
    });
    const defect = await prisma.defectItem.create({
      data: {
        actId: act.id,
        location: 'smtp',
        claimDetails: 'claim',
        defectTypeId: defectType.id,
      },
    });
    const event = await prisma.notificationEvent.create({
      data: {
        type: 'RESPONSIBLE_ASSIGNED',
        occurrenceKey: `smtp:${suffix}:${randomUUID()}`,
        actId: act.id,
        defectItemId: defect.id,
        payload: { title: 'Назначение', body: 'Назначен ответственный' },
        occurredAt: new Date(),
      },
    });
    const recipient = await prisma.notificationRecipient.create({
      data: { notificationEventId: event.id, userId: user.id },
    });
    const delivery = await prisma.emailDelivery.create({
      data: { notificationRecipientId: recipient.id, updatedAt: new Date() },
    });
    return { user, delivery, act, event };
  }

  it('sends via Mailpit, keeps Message-ID stable, and marks SENT', async () => {
    const { user, delivery } = await createDeliveryFixture();
    await dispatcher.deliver(delivery.id);
    const sent = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(sent.status).toBe('SENT');
    const expected = emailMessageId(delivery.id, loadConfig().EMAIL_FROM);
    expect(sent.providerMessageId).toBe(expected);
    const headers = await mailpitHeaders(user.email);
    expect(headers.some((item) => item.includes(delivery.id))).toBe(true);
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SENDING', nextAttemptAt: new Date(Date.now() - 1_000), sentAt: null },
    });
    await dispatcher.deliver(delivery.id);
    const retried = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(retried.status).toBe('SENT');
    expect(retried.providerMessageId).toBe(expected);
    const after = await mailpitHeaders(user.email);
    expect(after.every((item) => item.includes(delivery.id))).toBe(true);
  });

  it('does not hold a PostgreSQL transaction during an SMTP timeout', async () => {
    const smtp = await startFakeSmtp({ hangAfterConnect: true });
    process.env.SMTP_HOST = smtp.host;
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_TIMEOUT_MS = '2000';
    const { delivery } = await createDeliveryFixture();
    const started = Date.now();
    const pending = dispatcher.deliver(delivery.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await idleInTransactionCount()).toBe(0);
    const pingStarted = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    expect(Date.now() - pingStarted).toBeLessThan(1_000);
    await pending.catch(() => undefined);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThan(1_500);
    expect(elapsed).toBeLessThan(PREVIOUS_RLS_TX_TIMEOUT_MS);
    const row = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe('FAILED');
    expect(row.lastErrorCode).toBe('SMTP_TIMEOUT');
    expect(JSON.stringify(row)).not.toMatch(/password|SMTP_PASSWORD|token=/i);
    await smtp.close();
  });

  it('retries connection refused and 4xx, and dead-letters 5xx', async () => {
    const { delivery: refused } = await createDeliveryFixture();
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1';
    await dispatcher.deliver(refused.id).catch(() => undefined);
    const afterRefused = await prisma.emailDelivery.findUniqueOrThrow({
      where: { id: refused.id },
    });
    expect(afterRefused.status).toBe('FAILED');
    expect(afterRefused.lastErrorCode).toBe('SMTP_CONNECTION');
    expect(afterRefused.attempts).toBe(1);

    const smtp4 = await startFakeSmtp({ dataReply: '450 4.2.0 Try again later' });
    process.env.SMTP_HOST = smtp4.host;
    process.env.SMTP_PORT = String(smtp4.port);
    const { delivery: temp } = await createDeliveryFixture();
    await dispatcher.deliver(temp.id).catch(() => undefined);
    const after4 = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: temp.id } });
    expect(after4.status).toBe('FAILED');
    expect(after4.lastErrorCode).toBe('SMTP_4XX');
    await smtp4.close();

    const smtp5 = await startFakeSmtp({ dataReply: '550 5.1.1 User unknown' });
    process.env.SMTP_HOST = smtp5.host;
    process.env.SMTP_PORT = String(smtp5.port);
    const { delivery: perm } = await createDeliveryFixture();
    await dispatcher.deliver(perm.id);
    const after5 = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: perm.id } });
    expect(after5.status).toBe('DEAD');
    expect(after5.lastErrorCode).toBe('SMTP_5XX');
    await smtp5.close();
  });

  it('lets only one worker send when two claim the same delivery', async () => {
    const { delivery } = await createDeliveryFixture();
    await Promise.all([dispatcher.deliver(delivery.id), dispatcher.deliver(delivery.id)]);
    const row = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe('SENT');
    expect(row.attempts).toBe(1);
  });

  it('reclaims an expired SENDING lease after a worker crash', async () => {
    const { delivery } = await createDeliveryFixture();
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'SENDING',
        attempts: 1,
        nextAttemptAt: new Date(Date.now() - 1_000),
      },
    });
    await dispatcher.deliver(delivery.id);
    const row = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe('SENT');
    expect(row.attempts).toBe(2);
  });

  it('keeps attempts bounded and stores only a safe error code', async () => {
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1';
    const { delivery } = await createDeliveryFixture();
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', attempts: 7, nextAttemptAt: new Date() },
    });
    await dispatcher.deliver(delivery.id);
    const row = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe('DEAD');
    expect(row.attempts).toBe(8);
    expect(row.lastErrorCode).toBe('SMTP_CONNECTION');
    expect(JSON.stringify(row)).not.toMatch(/password|SMTP_PASSWORD|sgr_.*_password/i);
  });

  it('does not hold a business transaction while SMTP is delayed past 20s', async () => {
    const delayMs = PREVIOUS_RLS_TX_TIMEOUT_MS + 1_500;
    const smtp = await startFakeSmtp({ dataDelayMs: delayMs });
    process.env.SMTP_HOST = smtp.host;
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_TIMEOUT_MS = String(delayMs + 8_000);
    const { delivery } = await createDeliveryFixture();
    const pending = dispatcher.deliver(delivery.id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const pingStarted = Date.now();
    await prisma.$queryRaw`SELECT 1 AS ping`;
    expect(Date.now() - pingStarted).toBeLessThan(1_000);
    expect(await idleInTransactionCount()).toBe(0);
    await pending;
    const row = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe('SENT');
    await smtp.close();
  }, 60_000);

  it('sets worker RLS context on each short claim/finalize transaction', async () => {
    const smtp = await startFakeSmtp({});
    process.env.SMTP_HOST = smtp.host;
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_TIMEOUT_MS = '8000';
    try {
      const { delivery } = await createDeliveryFixture();
      const secret = loadConfig().RLS_CONTEXT_SECRET;
      const workerDispatcher = new NotificationDispatcher(
        prismaWithRlsTransaction(workerPrisma),
        queue,
        (fn) => withWorkerDbContext({ prisma: workerPrisma, secret, callback: fn }),
      );
      await workerDispatcher.deliver(delivery.id);
      const row = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(row.status).toBe('SENT');
    } finally {
      await smtp.close();
    }
  });

  it('processes a backlog of 100 queued deliveries and recovers after restart', async () => {
    const suffix = Math.random().toString(16).slice(2, 8);
    const users = Array.from({ length: 100 }, (_, index) => ({
      ...personNameWriteFields(`Burst ${suffix} ${index}`, CONFIRMED_LAST_FIRST_TOKEN_ORDER),
      email: `burst.${suffix}.${index}@example.sgr.local`,
      role: 'RESPONSIBLE_ENGINEER' as const,
    }));
    await prisma.user.createMany({ data: users });
    const created = await prisma.user.findMany({
      where: { email: { startsWith: `burst.${suffix}.` } },
      select: { id: true },
    });
    createdUserIds.push(...created.map((row) => row.id));
    const object = await prisma.propertyObject.create({
      data: { name: `Burst ${suffix}`, address: 'Минск' },
    });
    const org = await prisma.organization.create({
      data: {
        officialName: `Burst org ${suffix}`,
        postalAddress: 'addr',
        email: `burst-org-${suffix}@example.sgr.local`,
        phone: '1',
        contactPerson: 'B',
      },
    });
    const act = await prisma.act.create({
      data: {
        officialNumber: `BURST-${suffix}`,
        formCode: 'S1',
        year: 2099,
        sequence: Math.floor(Math.random() * 800_000) + 100_000,
        objectId: object.id,
        customerOrganizationId: org.id,
        issuedOn: new Date('2026-01-15T12:00:00.000Z'),
        status: 'IN_PROGRESS',
        createdAt: new Date('2026-01-15T12:00:00.000Z'),
        startedAt: new Date('2026-01-15T12:00:00.000Z'),
      },
    });
    const defectType = await prisma.defectType.upsert({
      where: { code: 'SMTP_TEST' },
      update: {},
      create: { code: 'SMTP_TEST', name: 'SMTP test', sortOrder: 902, active: true },
    });
    const defect = await prisma.defectItem.create({
      data: {
        actId: act.id,
        location: 'burst',
        claimDetails: 'claim',
        defectTypeId: defectType.id,
      },
    });
    const event = await prisma.notificationEvent.create({
      data: {
        type: 'RESPONSIBLE_ASSIGNED',
        occurrenceKey: `burst:${suffix}`,
        actId: act.id,
        defectItemId: defect.id,
        payload: { title: 'Назначение', body: 'burst' },
        occurredAt: new Date(),
      },
    });
    for (const user of created) {
      const recipient = await prisma.notificationRecipient.create({
        data: { notificationEventId: event.id, userId: user.id },
      });
      await prisma.emailDelivery.create({
        data: { notificationRecipientId: recipient.id, updatedAt: new Date() },
      });
    }
    const started = Date.now();
    const rows = await prisma.emailDelivery.findMany({
      where: { recipient: { notificationEventId: event.id } },
      select: { id: true },
    });
    expect(rows).toHaveLength(100);
    for (const row of rows) {
      await dispatcher.deliver(row.id);
    }
    const elapsed = Date.now() - started;
    const sent = await prisma.emailDelivery.count({
      where: { recipient: { notificationEventId: event.id }, status: 'SENT' },
    });
    expect(sent).toBe(100);
    expect(elapsed).toBeLessThan(60_000);

    const leftover = await prisma.emailDelivery.findFirst({
      where: { recipient: { notificationEventId: event.id } },
    });
    expect(leftover).toBeTruthy();
    await prisma.emailDelivery.update({
      where: { id: leftover?.id ?? '' },
      data: { status: 'QUEUED', nextAttemptAt: new Date(), sentAt: null, providerMessageId: null },
    });
    await dispatcher.recover();
    await dispatcher.deliver(leftover?.id ?? '');
    const recovered = await prisma.emailDelivery.findUniqueOrThrow({
      where: { id: leftover?.id ?? '' },
    });
    expect(recovered.status).toBe('SENT');
  }, 90_000);

  it('stops the worker during SMTP without leaving idle in transaction', async () => {
    const delayMs = 3_000;
    const smtp = await startFakeSmtp({ dataDelayMs: delayMs });
    process.env.SMTP_HOST = smtp.host;
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_TIMEOUT_MS = '8000';
    const { delivery } = await createDeliveryFixture();
    let runtime: WorkerRuntime | undefined;
    try {
      runtime = await startWorkerRuntime({ listenHealth: false, scheduleOnStart: false });
      await queue.add(
        EMAIL_DELIVER_JOB,
        { deliveryId: delivery.id },
        { jobId: emailJobId(delivery.id) },
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await idleInTransactionCount()).toBe(0);
      const stoppedAt = Date.now();
      await runtime.stop();
      expect(Date.now() - stoppedAt).toBeLessThan(8_000);
      expect(await idleInTransactionCount()).toBe(0);
    } finally {
      await runtime?.stop();
      await smtp.close();
    }
  }, 20_000);
});
