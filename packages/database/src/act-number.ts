import type { ActFormCode, Prisma, PrismaClient } from '@prisma/client';
import { calendarYearFromDate, formatOfficialActNumber } from '@sgr-registry/domain';
import { ALLOCATE_ACT_SEQUENCE_SQL } from './act-number-sql';

export { ALLOCATE_ACT_SEQUENCE_SQL };

export interface AllocatedActNumberRecord {
  formCode: ActFormCode;
  year: number;
  sequence: number;
  officialNumber: string;
}

type DbClient = PrismaClient | Prisma.TransactionClient;

export async function allocateActNumber(
  db: DbClient,
  formCode: ActFormCode,
  issuedAt: Date,
): Promise<AllocatedActNumberRecord> {
  if (formCode !== 'S1' && formCode !== 'S23') {
    throw new Error('Unsupported act form code');
  }

  const year = calendarYearFromDate(issuedAt);
  const rows = await db.$queryRawUnsafe<Array<{ lastIssued: number }>>(
    ALLOCATE_ACT_SEQUENCE_SQL,
    formCode,
    year,
  );

  const lastIssued = rows[0]?.lastIssued;
  if (lastIssued === undefined) {
    throw new Error('Failed to allocate act number sequence');
  }

  return {
    formCode,
    year,
    sequence: lastIssued,
    officialNumber: formatOfficialActNumber(formCode, year, lastIssued),
  };
}
