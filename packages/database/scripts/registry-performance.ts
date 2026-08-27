import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { createPrismaClient } from '../src/client';
import { assertSafeTestDatabaseUrl } from '../src/test-database';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile });

const MARKER = 'PERF-LOAD';
const TARGET_ITEMS = 100_000;

async function main(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Set TEST_DATABASE_URL to a dedicated *_test database');
  }
  assertSafeTestDatabaseUrl(databaseUrl);
  const prisma = createPrismaClient(databaseUrl);
  const started = Date.now();
  try {
    await cleanup(prisma);
    const defectType = await prisma.defectType.upsert({
      where: { code: 'PERF_LOAD' },
      update: {},
      create: { code: 'PERF_LOAD', name: `${MARKER} вид`, sortOrder: 999, active: true },
    });
    const object = await prisma.propertyObject.create({
      data: { name: `${MARKER} объект`, address: `${MARKER} адрес` },
    });
    const customer = await prisma.organization.create({
      data: {
        officialName: `${MARKER} заказчик`,
        postalAddress: MARKER,
        email: 'perf@example.sgr.local',
        phone: '0',
        contactPerson: MARKER,
      },
    });

    await prisma.$executeRawUnsafe(`
      INSERT INTO acts (id, "officialNumber", "formCode", year, sequence, "objectId", "customerOrganizationId", status, version, "issuedOn", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), '${MARKER}-' || g, 'S1', 2099, g, '${object.id}'::uuid, '${customer.id}'::uuid, 'IN_PROGRESS', 1, TIMESTAMPTZ '2026-08-20 12:00:00+00', NOW(), NOW()
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

    const count = await prisma.defectItem.count({
      where: { location: { startsWith: `${MARKER} помещение` } },
    });
    if (count < TARGET_ITEMS) {
      throw new Error(`Expected at least ${TARGET_ITEMS} performance rows, got ${count}`);
    }

    const explain = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT di.id
      FROM defect_items di
      INNER JOIN acts a ON a.id = di."actId"
      WHERE a.status <> 'CANCELLED'
        AND di.status = 'IN_PROGRESS'
      ORDER BY di."effectiveDeadline" ASC NULLS LAST, a."officialNumber" ASC, di.id ASC
      OFFSET 0 LIMIT 50
      `,
    );
    const plan = explain.map((row) => row['QUERY PLAN']).join('\n');
    const elapsed = Date.now() - started;
    console.log('--- registry performance ---');
    console.log(`dataset=${count} DefectItem`);
    console.log(`setup_and_query_ms=${elapsed}`);
    console.log(plan);
    if (!/Limit/.test(plan)) {
      throw new Error('Query plan did not use a Limit; pagination may be loading all rows');
    }
  } finally {
    await cleanup(prisma);
    await prisma.$disconnect();
  }
}

async function cleanup(prisma: ReturnType<typeof createPrismaClient>): Promise<void> {
  await prisma.$executeRawUnsafe(`
    DELETE FROM defect_items
    WHERE location LIKE '${MARKER} помещение%'
       OR "actId" IN (SELECT id FROM acts WHERE "officialNumber" LIKE '${MARKER}-%')
  `);
  await prisma.$executeRawUnsafe(`DELETE FROM acts WHERE "officialNumber" LIKE '${MARKER}-%'`);
  await prisma.organization.deleteMany({ where: { officialName: `${MARKER} заказчик` } });
  await prisma.propertyObject.deleteMany({ where: { name: `${MARKER} объект` } });
  await prisma.defectType.deleteMany({ where: { code: 'PERF_LOAD' } });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Performance check failed';
  console.error(message);
  process.exit(1);
});
