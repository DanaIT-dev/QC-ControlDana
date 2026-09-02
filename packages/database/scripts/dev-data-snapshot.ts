import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from '@sgr-registry/config';
import { createOwnerPrismaClient, databaseNameOf, postgresHostOf } from '../src/index';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile, override: false });

async function main(): Promise<void> {
  const config = loadConfig();
  const url = config.MIGRATION_DATABASE_URL;
  const databaseName = databaseNameOf(url);
  const host = postgresHostOf(url);
  if (databaseName !== 'sgr_registry') {
    throw new Error(`Refusing snapshot because database is not sgr_registry`);
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('Refusing snapshot because host is not loopback');
  }

  const prisma = createOwnerPrismaClient(url);
  try {
    const [users, objects, acts, defects, assignments, defectTypes, workTypes, orgs] =
      await Promise.all([
        prisma.user.findMany({
          select: { email: true, role: true, status: true },
          orderBy: { email: 'asc' },
        }),
        prisma.propertyObject.count(),
        prisma.act.count(),
        prisma.defectItem.count(),
        prisma.propertyObjectEngineer.count(),
        prisma.defectType.findMany({
          select: { name: true, code: true, active: true, sortOrder: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        prisma.workType.findMany({
          select: { name: true, code: true, active: true, sortOrder: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        prisma.organization.findMany({
          select: { officialName: true, unp: true, email: true, active: true },
          orderBy: { officialName: 'asc' },
        }),
      ]);
    const credentials = await prisma.userCredential.findMany({
      select: { passwordHash: true },
    });
    const testUsers = users.filter((user) => user.email.endsWith('@example.sgr.local'));
    const hashFingerprints = credentials
      .map((row) => createHash('sha256').update(row.passwordHash).digest('hex').slice(0, 12))
      .sort();
    process.stdout.write(
      `${JSON.stringify(
        {
          target: { database: databaseName, host, nodeEnv: config.NODE_ENV },
          users: users.map((user) => ({ email: user.email, role: user.role, status: user.status })),
          userCount: users.length,
          testUsers: testUsers.length,
          objects,
          acts,
          defects,
          assignments,
          defectTypeCount: defectTypes.length,
          defectTypes,
          workTypeCount: workTypes.length,
          workTypes,
          organizationCount: orgs.length,
          organizations: orgs.map((org) => ({
            officialName: org.officialName,
            unp: org.unp,
            hasEmail: Boolean(org.email),
            active: org.active,
          })),
          credentialCount: credentials.length,
          hashFingerprints,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main();
