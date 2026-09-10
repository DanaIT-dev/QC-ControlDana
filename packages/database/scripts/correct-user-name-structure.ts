import { existsSync } from 'node:fs';
import { stdout } from 'node:process';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from '@sgr-registry/config';
import {
  confirmTwoTokenOfficialName,
  formatPersonFull,
  formatPersonShort,
} from '@sgr-registry/domain';
import { createOwnerPrismaClient, databaseNameOf } from '../src/index';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile, override: false });

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function printHelp(): void {
  stdout.write(`Correct a stored two-token person name with an explicit mapping.

  pnpm --filter @sgr-registry/database exec tsx scripts/correct-user-name-structure.ts \\
    --user-id=<uuid> --last-name=<Last> --first-name=<First> --confirm-database=sgr_registry

Does not change email, role, status, passwordHash or sessionVersion.
`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }
  const userId = argValue('user-id');
  const lastName = argValue('last-name');
  const firstName = argValue('first-name');
  const middleName = argValue('middle-name');
  const confirmDatabase = argValue('confirm-database');
  if (!userId || !lastName || !firstName || !confirmDatabase) {
    throw new Error('Required: --user-id --last-name --first-name --confirm-database');
  }
  const config = loadConfig();
  const databaseUrl = config.MIGRATION_DATABASE_URL;
  const databaseName = databaseNameOf(databaseUrl);
  if (databaseName !== confirmDatabase) {
    throw new Error(
      `Database ${databaseName} does not match --confirm-database=${confirmDatabase}`,
    );
  }
  if (/prod/i.test(databaseName) && databaseName !== 'sgr_registry') {
    throw new Error(`Refusing name correction on ${databaseName}`);
  }
  if (config.NODE_ENV === 'production') {
    throw new Error('Production name correction is not enabled.');
  }
  const prisma = createOwnerPrismaClient(databaseUrl);
  try {
    const current = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        lastName: true,
        firstName: true,
        middleName: true,
        sessionVersion: true,
      },
    });
    const credentials = await prisma.userCredential.findUnique({
      where: { userId },
      select: { passwordHash: true },
    });
    const mapping = confirmTwoTokenOfficialName(current.fullName, { lastName, firstName });
    if (middleName !== undefined && middleName !== '') {
      throw new Error('Two-token correction does not accept a middle name');
    }
    const rows = await prisma.$queryRaw<
      Array<{
        last_name: string;
        first_name: string;
        middle_name: string | null;
        full_name: string;
        session_version: number;
      }>
    >`
      SELECT last_name, first_name, middle_name, full_name, session_version
      FROM public.sgr_correct_user_name_structure(
        ${userId}::uuid,
        ${mapping.lastName},
        ${mapping.firstName},
        ${null}
      )
    `;
    const updated = rows[0];
    if (!updated) {
      throw new Error('Name structure was not updated');
    }
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    const credentialsAfter = await prisma.userCredential.findUnique({
      where: { userId },
      select: { passwordHash: true },
    });
    if (after.sessionVersion !== current.sessionVersion) {
      throw new Error('sessionVersion changed');
    }
    if (credentials?.passwordHash !== credentialsAfter?.passwordHash) {
      throw new Error('passwordHash changed');
    }
    const report = {
      userId,
      lastName: updated.last_name,
      firstName: updated.first_name,
      middleName: updated.middle_name,
      fullName: updated.full_name,
      shortName: formatPersonShort({
        lastName: updated.last_name,
        firstName: updated.first_name,
        middleName: updated.middle_name,
      }),
      canonicalFullName: formatPersonFull({
        lastName: updated.last_name,
        firstName: updated.first_name,
        middleName: updated.middle_name,
      }),
      sessionVersion: updated.session_version,
    };
    if (/email|passwordHash|csrf/i.test(JSON.stringify(report))) {
      throw new Error('Refusing to print a report that contains sensitive fields');
    }
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Name correction failed';
  console.error(message);
  process.exit(1);
});
