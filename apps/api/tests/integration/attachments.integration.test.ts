import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from '@sgr-registry/config';
import {
  allocateActNumber,
  assertSafeTestBucket,
  createOwnerPrismaClient,
  disconnectPrismaClient,
  Prisma,
  upsertUserCredentials,
  type PrismaClient,
} from '@sgr-registry/database';
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from '@sgr-registry/domain';
import FormData from 'form-data';
import { Readable } from 'node:stream';
import Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/configure-http';
import { hashArgon2id } from '../../src/auth/crypto';
import { ClamdClient } from '../../src/attachments/clamd.client';
import type { UserRole } from '@sgr-registry/contracts';
import { startWorkerRuntime, type WorkerRuntime } from '../../../worker/src/runtime';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

let app: NestFastifyApplication;
let prisma: PrismaClient;
let redis: Redis;
let worker: WorkerRuntime;
const createdUserIds: string[] = [];
const createdActIds: string[] = [];

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
  body: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
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
      'x-request-id': `att-${Date.now()}-${Math.random()}`,
      ...opts.headers,
    },
  }) as Promise<InjectResponse>;
}

async function createUser(role: UserRole) {
  const email = `att.${role.toLowerCase()}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.sgr.local`;
  const passwordHash = await hashArgon2id(DEMO_PASSWORD, { memoryCost: 4096, timeCost: 1 });
  const user = await prisma.user.create({
    data: { fullName: `Вложения ${role}`, email, role, status: 'ACTIVE' },
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
    headers: { 'content-type': 'application/json' },
  });
  const body = response.json() as { csrfToken: string; id: string };
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE_NAME)?.value ?? '';
  return { body, cookie };
}

function pdfBytes(payload = 'clean-document'): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\nstream\n${payload}\nendstream\n%%EOF\n`);
}

function threatPdf(): Buffer {
  return pdfBytes(`clean-prefix SGR-ATTACHMENT-TEST-THREAT suffix`);
}

function eicarBytes(): Buffer {
  return Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
}

async function upload(
  session: { cookie: string; body: { csrfToken: string } },
  url: string,
  file: Buffer,
  filename: string,
  mime: string,
  category: string,
  extraHeaders: Record<string, string> = {},
) {
  const boundary = `----SgrTestBoundary${Date.now()}`;
  const prefix = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\n${category}\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
  ]);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([prefix, file, suffix]);
  return inject({
    method: 'POST',
    url,
    payload,
    cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      [CSRF_HEADER_NAME]: session.body.csrfToken,
      ...extraHeaders,
    },
  });
}

async function waitStatus(id: string, wanted: string, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = await prisma.attachment.findUnique({ where: { id } });
    if (row?.status === wanted) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const last = await prisma.attachment.findUnique({ where: { id } });
  throw new Error(`Timed out waiting for ${wanted}; last status=${last?.status ?? 'missing'}`);
}

describe('attachments integration', () => {
  let admin: { id: string; email: string };
  let contractor: { id: string; email: string };
  let responsible: { id: string; email: string };
  let otherResponsible: { id: string; email: string };
  let actId = '';
  let assignedDefectId = '';
  let foreignDefectId = '';
  let proposalAId = '';
  let proposalBId = '';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.REDIS_KEY_PREFIX = 'sgr-test';
    const config = loadConfig();
    assertSafeTestBucket(config.S3_TEST_BUCKET);
    prisma = createOwnerPrismaClient(config.MIGRATION_DATABASE_URL);
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
    const clamd = new ClamdClient(config.CLAMD_HOST, config.CLAMD_PORT);
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 240_000) {
      try {
        await clamd.ping();
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    if (!ready) {
      throw new Error('ClamAV did not become ready for attachment integration tests');
    }
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({
        logger: false,
        trustProxy: false,
        bodyLimit: config.ATTACHMENT_MAX_BYTES + 1024 * 1024,
      }),
      { logger: false },
    );
    await configureHttpApp(app, config);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    worker = await startWorkerRuntime({ listenHealth: false, scheduleOnStart: false });

    admin = await createUser('ADMIN');
    contractor = await createUser('CONTRACTOR_ENGINEER');
    responsible = await createUser('RESPONSIBLE_ENGINEER');
    otherResponsible = await createUser('RESPONSIBLE_ENGINEER');
    const suffix = Math.random().toString(16).slice(2, 8);
    const object = await prisma.propertyObject.create({
      data: { name: `Объект ${suffix}`, address: 'Минск' },
    });
    const customer = await prisma.organization.create({
      data: {
        officialName: `Заказчик ${suffix}`,
        postalAddress: 'addr',
        email: `cust-${suffix}@example.sgr.local`,
        phone: '1',
        contactPerson: 'К',
        roles: { create: [{ role: 'CUSTOMER' }] },
      },
    });
    const alt = await prisma.organization.create({
      data: {
        officialName: `Альт ${suffix}`,
        postalAddress: 'addr',
        email: `alt-${suffix}@example.sgr.local`,
        phone: '1',
        contactPerson: 'А',
        roles: { create: [{ role: 'ALTERNATIVE_CONTRACTOR' }] },
      },
    });
    const defectType = await prisma.defectType.create({
      data: { code: `ATT-${suffix}`, name: `Тип ${suffix}`, sortOrder: 50 },
    });
    const issuedAt = new Date('2026-05-01T09:00:00.000Z');
    const number = await allocateActNumber(prisma, 'S1', issuedAt);
    const act = await prisma.act.create({
      data: {
        officialNumber: number.officialNumber,
        formCode: number.formCode,
        year: number.year,
        sequence: number.sequence,
        objectId: object.id,
        customerOrganizationId: customer.id,
        status: 'IN_PROGRESS',
        startedAt: issuedAt,
        issuedOn: issuedAt,
        createdAt: issuedAt,
      },
    });
    createdActIds.push(act.id);
    actId = act.id;
    const assigned = await prisma.defectItem.create({
      data: {
        actId: act.id,
        location: 'Назначенная квартира',
        defectTypeId: defectType.id,
        status: 'IN_PROGRESS',
        claimDetails: 'assigned',
      },
    });
    assignedDefectId = assigned.id;
    await prisma.defectItemEngineer.create({
      data: { defectItemId: assigned.id, userId: responsible.id },
    });
    const foreign = await prisma.defectItem.create({
      data: {
        actId: act.id,
        location: 'Чужая квартира',
        defectTypeId: defectType.id,
        status: 'IN_PROGRESS',
        claimDetails: 'foreign',
      },
    });
    foreignDefectId = foreign.id;
    await prisma.defectItemEngineer.create({
      data: { defectItemId: foreign.id, userId: otherResponsible.id },
    });
    await prisma.propertyObjectEngineer.createMany({
      data: [
        { propertyObjectId: object.id, userId: responsible.id },
        { propertyObjectId: object.id, userId: otherResponsible.id },
      ],
    });
    const proposalA = await prisma.proposal.create({
      data: {
        defectItemId: assigned.id,
        slot: 'A',
        alternativeContractorOrganizationId: alt.id,
        amount: new Prisma.Decimal('100.00'),
        currency: 'BYN',
      },
    });
    const proposalB = await prisma.proposal.create({
      data: {
        defectItemId: assigned.id,
        slot: 'B',
        alternativeContractorOrganizationId: alt.id,
        amount: new Prisma.Decimal('110.00'),
        currency: 'BYN',
      },
    });
    proposalAId = proposalA.id;
    proposalBId = proposalB.id;
  });

  beforeEach(async () => {
    const keys = await redis.keys('sgr-test:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  afterAll(async () => {
    await worker?.stop();
    await app?.close();
    await redis?.quit();
    await prisma?.$disconnect();
    await disconnectPrismaClient();
  });

  it('reports minio and clamav on ready', async () => {
    const session = await login(admin.email);
    const response = await inject({
      method: 'GET',
      url: '/api/ready',
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      components: { minio: { status: string }; clamav: { status: string } };
    };
    expect(body.status).toBe('ready');
    expect(body.components.minio.status).toBe('up');
    expect(body.components.clamav.status).toBe('up');
    expect(JSON.stringify(body)).not.toMatch(
      /redis:\/\/|rediss:\/\/|sgr_api|sgr_worker|local-development-only/,
    );
  });

  it('uploads a PDF through the stream path, scans CLEAN, and serves READY content', async () => {
    const session = await login(admin.email);
    const file = pdfBytes(`act-${Date.now()}`);
    const response = await upload(
      session,
      `/api/acts/${actId}/attachments`,
      file,
      'act.pdf',
      'application/pdf',
      'ACT_DOCUMENT',
    );
    expect(response.statusCode).toBe(202);
    const body = response.json() as Record<string, unknown>;
    expect(body.status).toBe('PENDING_SCAN');
    expect(JSON.stringify(body)).not.toMatch(/objectKey|bucket|sgr_minio|S3_|attachments\//);
    const id = String(body.id);
    const row = await waitStatus(id, 'READY');
    expect(row.objectKey).toBe(`attachments/${id}`);
    expect(row.originalFilename).toBe('act.pdf');
    const list = await inject({
      method: 'GET',
      url: `/api/acts/${actId}/attachments`,
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    });
    const listed = list.json() as { items: Array<{ id: string; status: string }> };
    expect(listed.items.some((item) => item.id === id && item.status === 'READY')).toBe(true);
    const content = await inject({
      method: 'GET',
      url: `/api/attachments/${id}/content`,
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    });
    expect(content.statusCode).toBe(200);
    expect(String(content.headers['x-content-type-options'])).toBe('nosniff');
    expect(String(content.headers['cache-control'])).toMatch(/no-store/);
    expect(String(content.headers['content-disposition'])).toMatch(/filename/);
    expect(String(content.headers['content-disposition'])).not.toMatch(/\r|\n/);
    const ranged = await inject({
      method: 'GET',
      url: `/api/attachments/${id}/content`,
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
      headers: { range: 'bytes=0-3' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(Buffer.from(ranged.body).toString('utf8')).toBe('%PDF');
  });

  it('rejects empty, svg, html, zip, path, double-ext and mime mismatch', async () => {
    const session = await login(admin.email);
    const url = `/api/acts/${actId}/attachments`;
    expect(
      (await upload(session, url, Buffer.alloc(0), 'empty.pdf', 'application/pdf', 'ACT_DOCUMENT'))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await upload(
          session,
          url,
          Buffer.from('<svg></svg>'),
          'x.svg',
          'image/svg+xml',
          'ACT_DOCUMENT',
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await upload(
          session,
          url,
          Buffer.from('<html><body>x</body></html>'),
          'x.html',
          'text/html',
          'ACT_DOCUMENT',
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await upload(
          session,
          url,
          Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
          'x.zip',
          'application/zip',
          'ACT_DOCUMENT',
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await upload(session, url, pdfBytes(), '.._secret.pdf', 'application/pdf', 'ACT_DOCUMENT'))
        .statusCode,
    ).toBe(400);
    expect(
      (await upload(session, url, pdfBytes(), 'payload.exe.pdf', 'application/pdf', 'ACT_DOCUMENT'))
        .statusCode,
    ).toBe(400);
    expect(
      (await upload(session, url, pdfBytes(), 'x.pdf', 'image/png', 'ACT_DOCUMENT')).statusCode,
    ).toBe(400);
  });

  it('rejects a duplicate file with 409 and stores one object', async () => {
    const session = await login(admin.email);
    const file = pdfBytes(`dup-${Date.now()}`);
    const first = await upload(
      session,
      `/api/acts/${actId}/attachments`,
      file,
      'dup.pdf',
      'application/pdf',
      'ACT_SCAN',
    );
    expect(first.statusCode).toBe(202);
    const firstId = String((first.json() as { id: string }).id);
    await waitStatus(firstId, 'READY');
    const second = await upload(
      session,
      `/api/acts/${actId}/attachments`,
      file,
      'dup.pdf',
      'application/pdf',
      'ACT_SCAN',
    );
    expect(second.statusCode).toBe(409);
  });

  it('requires CSRF on upload', async () => {
    const session = await login(admin.email);
    const form = new FormData();
    form.append('category', 'ACT_DOCUMENT');
    form.append('file', pdfBytes('csrf-missing'), {
      filename: 'csrf.pdf',
      contentType: 'application/pdf',
    });
    const missing = await inject({
      method: 'POST',
      url: `/api/acts/${actId}/attachments`,
      payload: form,
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
      headers: form.getHeaders(),
    });
    expect(missing.statusCode).toBe(403);
  });

  it('hides capabilities and owners by role', async () => {
    const contractorSession = await login(contractor.email);
    const responsibleSession = await login(responsible.email);
    const actUpload = await upload(
      contractorSession,
      `/api/acts/${actId}/attachments`,
      pdfBytes('contractor-act'),
      'c.pdf',
      'application/pdf',
      'ACT_DOCUMENT',
    );
    expect(actUpload.statusCode).toBe(403);
    const thirdParty = await upload(
      contractorSession,
      `/api/defects/${assignedDefectId}/attachments`,
      pdfBytes(`tp-${Date.now()}`),
      'third.pdf',
      'application/pdf',
      'THIRD_PARTY_DOCUMENT',
    );
    expect(thirdParty.statusCode).toBe(202);
    const responsibleAct = await upload(
      responsibleSession,
      `/api/acts/${actId}/attachments`,
      pdfBytes('resp-act'),
      'r.pdf',
      'application/pdf',
      'ACT_DOCUMENT',
    );
    expect(responsibleAct.statusCode).toBe(202);
    const hiddenDefect = await inject({
      method: 'GET',
      url: `/api/defects/${foreignDefectId}/attachments`,
      cookies: { [SESSION_COOKIE_NAME]: responsibleSession.cookie },
    });
    expect(hiddenDefect.statusCode).toBe(200);
    const hiddenB = await inject({
      method: 'GET',
      url: `/api/proposals/${proposalBId}/attachments`,
      cookies: { [SESSION_COOKIE_NAME]: responsibleSession.cookie },
    });
    expect(hiddenB.statusCode).toBe(404);
    expect(JSON.stringify(hiddenB.json())).not.toContain(proposalBId);
    const visibleA = await inject({
      method: 'GET',
      url: `/api/proposals/${proposalAId}/attachments`,
      cookies: { [SESSION_COOKIE_NAME]: responsibleSession.cookie },
    });
    expect(visibleA.statusCode).toBe(200);
  });

  it('does not download until READY and archives without deleting history', async () => {
    const session = await login(admin.email);
    const pending = await prisma.attachment.create({
      data: {
        actId,
        originalFilename: 'pending.pdf',
        safeDisplayName: 'pending.pdf',
        objectKey: null,
        bucket: loadConfig().S3_TEST_BUCKET,
        sizeBytes: 12,
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        sha256: `pending-${Date.now()}`,
        category: 'ACT_DOCUMENT',
        status: 'PENDING_SCAN',
        uploadedById: admin.id,
      },
    });
    const pendingContent = await inject({
      method: 'GET',
      url: `/api/attachments/${pending.id}/content`,
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    });
    expect(pendingContent.statusCode).toBe(404);
    const uploaded = await upload(
      session,
      `/api/acts/${actId}/attachments`,
      pdfBytes(`arch-${Date.now()}`),
      'arch.pdf',
      'application/pdf',
      'OTHER',
    );
    const id = String((uploaded.json() as { id: string }).id);
    const ready = await waitStatus(id, 'READY');
    const archived = await inject({
      method: 'POST',
      url: `/api/attachments/${id}/archive`,
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
      headers: { 'content-type': 'application/json', [CSRF_HEADER_NAME]: session.body.csrfToken },
      payload: { expectedVersion: ready.version, reason: 'Больше не нужен' },
    });
    expect(archived.statusCode).toBe(200);
    const list = await inject({
      method: 'GET',
      url: `/api/acts/${actId}/attachments`,
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    });
    const items = (list.json() as { items: Array<{ id: string }> }).items;
    expect(items.some((item) => item.id === id)).toBe(false);
    const content = await inject({
      method: 'GET',
      url: `/api/attachments/${id}/content`,
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    });
    expect(content.statusCode).toBe(404);
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: id, action: 'ATTACHMENT_ARCHIVED' },
    });
    expect(audit).toBeTruthy();
  });

  it('detects EICAR over clamd INSTREAM and rejects a signed test PDF', async () => {
    const clamd = new ClamdClient(loadConfig().CLAMD_HOST, loadConfig().CLAMD_PORT);
    const eicar = await clamd.scanStream(Readable.from(eicarBytes()));
    expect(eicar.clean).toBe(false);
    expect(eicar.signature).toMatch(/eicar/i);

    const session = await login(admin.email);
    const response = await upload(
      session,
      `/api/acts/${actId}/attachments`,
      threatPdf(),
      'threat.pdf',
      'application/pdf',
      'ACT_DOCUMENT',
    );
    expect(response.statusCode).toBe(202);
    const id = String((response.json() as { id: string }).id);
    const row = await waitStatus(id, 'REJECTED');
    expect(row.objectKey).toBeNull();
    const content = await inject({
      method: 'GET',
      url: `/api/attachments/${id}/content`,
      cookies: { [SESSION_COOKIE_NAME]: session.cookie },
    });
    expect(content.statusCode).toBe(404);
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: id, action: 'ATTACHMENT_REJECTED' },
    });
    expect(JSON.stringify(audit)).not.toMatch(/objectKey|sgr_minio|rawScanner/);
  });

  it('enforces owner XOR in PostgreSQL', async () => {
    await expect(
      prisma.attachment.create({
        data: {
          actId,
          defectItemId: assignedDefectId,
          originalFilename: 'xor.pdf',
          safeDisplayName: 'xor.pdf',
          bucket: 'sgr-attachments-test',
          sizeBytes: 1,
          declaredMimeType: 'application/pdf',
          sha256: `xor-${Date.now()}`,
          category: 'ACT_DOCUMENT',
          status: 'READY',
          uploadedById: admin.id,
        },
      }),
    ).rejects.toThrow();
  });
});
