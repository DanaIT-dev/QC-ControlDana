import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { applyTestDatabaseEnv } from '../src/test-env';
import { createOwnerPrismaClient } from '../src/client';
import { assertSafeTestDatabaseUrl } from '../src/test-database';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile, override: true });

const MARKER = 'SLA-PERF';
const TARGET_ITEMS = 100_000;

async function main(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Set TEST_DATABASE_URL to a dedicated *_test database');
  }
  assertSafeTestDatabaseUrl(databaseUrl);
  applyTestDatabaseEnv(databaseUrl);
  const prisma = createOwnerPrismaClient(process.env.MIGRATION_DATABASE_URL ?? databaseUrl);
  const started = Date.now();
  const rssBefore = process.memoryUsage().rss;
  try {
    await cleanup(prisma);
    const defectType = await prisma.defectType.upsert({
      where: { code: 'SLA_PERF_LOAD' },
      update: {},
      create: { code: 'SLA_PERF_LOAD', name: `${MARKER} вид`, sortOrder: 998, active: true },
    });
    const object = await prisma.propertyObject.create({
      data: { name: `${MARKER} объект`, address: `${MARKER} адрес` },
    });
    const customer = await prisma.organization.create({
      data: {
        officialName: `${MARKER} заказчик`,
        postalAddress: MARKER,
        email: 'sla-perf@example.sgr.local',
        phone: '0',
        contactPerson: MARKER,
      },
    });
    await prisma.$executeRawUnsafe(`
      INSERT INTO acts (id, "officialNumber", "formCode", year, sequence, "objectId", "customerOrganizationId", status, version, "issuedOn", "startedAt", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), '${MARKER}-' || g, 'S1', 2098, g, '${object.id}'::uuid, '${customer.id}'::uuid, 'IN_PROGRESS', 1, TIMESTAMPTZ '2026-08-20 12:00:00+00', TIMESTAMPTZ '2026-08-20 12:00:00+00', NOW(), NOW()
      FROM generate_series(1, 200) AS g
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO defect_items (id, "actId", location, "defectTypeId", status, "claimDetails", "plannedDeadline", "createdAt", "updatedAt", version)
      SELECT gen_random_uuid(), a.id, '${MARKER} помещение ' || s, '${defectType.id}'::uuid, 'IN_PROGRESS', '${MARKER}',
             TIMESTAMPTZ '2026-12-01 12:00:00+00', NOW(), NOW(), 1
      FROM acts a
      CROSS JOIN generate_series(1, 500) AS s
      WHERE a."officialNumber" LIKE '${MARKER}-%'
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO sla_clocks (id, "defectItemId", kind, deadline, cycle, state, version, "createdAt", "updatedAt")
      SELECT gen_random_uuid(), d.id, 'GENERAL', d."plannedDeadline", 1, 'NORMAL', 1, NOW(), NOW()
      FROM defect_items d
      INNER JOIN acts a ON a.id = d."actId"
      WHERE a."officialNumber" LIKE '${MARKER}-%'
    `);
    const count = await prisma.defectItem.count({
      where: { location: { startsWith: `${MARKER} помещение` } },
    });
    if (count < TARGET_ITEMS) {
      throw new Error(`Expected at least ${TARGET_ITEMS} SLA performance rows, got ${count}`);
    }

    let cursor: string | undefined;
    let processed = 0;
    const evalStarted = Date.now();
    for (;;) {
      const batch = await prisma.defectItem.findMany({
        where: {
          status: 'IN_PROGRESS',
          location: { startsWith: `${MARKER} помещение` },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 100,
        select: { id: true },
      });
      if (batch.length === 0) {
        break;
      }
      cursor = batch[batch.length - 1]?.id;
      processed += batch.length;
      if (batch.length < 100) {
        break;
      }
    }
    const evalMs = Date.now() - evalStarted;
    const explain = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT c.id
      FROM sla_clocks c
      INNER JOIN defect_items di ON di.id = c."defectItemId"
      INNER JOIN acts a ON a.id = di."actId"
      WHERE a.status <> 'CANCELLED'
        AND di.status = 'IN_PROGRESS'
        AND c.kind = 'GENERAL'
      ORDER BY c.deadline ASC NULLS LAST, c."defectItemId" ASC
      OFFSET 0 LIMIT 50
      `,
    );
    const plan = explain.map((row) => row['QUERY PLAN']).join('\n');
    const rssAfter = process.memoryUsage().rss;
    console.log('--- SLA evaluator performance ---');
    console.log(`dataset=${count} DefectItem`);
    console.log(`cursor_processed=${processed}`);
    console.log(`cursor_ms=${evalMs}`);
    console.log(`rss_before_bytes=${rssBefore}`);
    console.log(`rss_after_bytes=${rssAfter}`);
    console.log(`setup_ms=${Date.now() - started}`);
    console.log('email_suppressed=true (dry-run cursor only, no outbox/email)');
    console.log(plan);
    if (processed < TARGET_ITEMS) {
      throw new Error('Cursor loop did not visit the full SLA performance dataset');
    }
    if (rssAfter - rssBefore > 500 * 1024 * 1024) {
      console.warn('RSS grew by more than 500 MiB; inspect cursor batching');
    }
  } finally {
    await cleanup(prisma);
    await prisma.$disconnect();
  }
}

async function cleanup(prisma: ReturnType<typeof createOwnerPrismaClient>): Promise<void> {
  await prisma.$executeRawUnsafe(`
    DELETE FROM sla_clocks
    WHERE "defectItemId" IN (
      SELECT id FROM defect_items
      WHERE location LIKE '${MARKER} помещение%'
         OR "actId" IN (SELECT id FROM acts WHERE "officialNumber" LIKE '${MARKER}-%')
    )
  `);
  await prisma.$executeRawUnsafe(`
    DELETE FROM defect_items
    WHERE location LIKE '${MARKER} помещение%'
       OR "actId" IN (SELECT id FROM acts WHERE "officialNumber" LIKE '${MARKER}-%')
  `);
  await prisma.$executeRawUnsafe(`DELETE FROM acts WHERE "officialNumber" LIKE '${MARKER}-%'`);
  await prisma.organization.deleteMany({ where: { officialName: `${MARKER} заказчик` } });
  await prisma.propertyObject.deleteMany({ where: { name: `${MARKER} объект` } });
  await prisma.defectType.deleteMany({ where: { code: 'SLA_PERF_LOAD' } });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'SLA performance check failed';
  console.error(message);
  process.exit(1);
});
