import type { Prisma, PrismaClient } from '@prisma/client';
import { currentRlsTransaction, runWithRlsTransaction } from './rls-als';
import { signUserRlsContext, signWorkerRlsContext } from './rls-context';

export type AuthenticatedDbUser = {
  id: string;
  sessionVersion: number;
};

export type AuthenticatedDbCallback<T> = (tx: Prisma.TransactionClient) => Promise<T>;

const TX_OPTIONS = { maxWait: 5_000, timeout: 20_000 } as const;

export async function withAuthenticatedDbContext<T>(options: {
  prisma: PrismaClient;
  secret: string;
  user: AuthenticatedDbUser;
  nonce?: string;
  callback: AuthenticatedDbCallback<T>;
}): Promise<T> {
  const token = signUserRlsContext(
    {
      userId: options.user.id,
      sessionVersion: options.user.sessionVersion,
      nonce: options.nonce,
    },
    options.secret,
  );
  return options.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT sgr_set_request_context(${token})`;
    try {
      return await runWithRlsTransaction(tx, () => {
        const scoped = currentRlsTransaction();
        if (!scoped) {
          throw new Error('RLS transaction is not available');
        }
        return options.callback(scoped);
      });
    } finally {
      await tx.$executeRaw`SELECT sgr_clear_request_context()`.catch(() => undefined);
    }
  }, TX_OPTIONS);
}

export async function withWorkerDbContext<T>(options: {
  prisma: PrismaClient;
  secret: string;
  callback: AuthenticatedDbCallback<T>;
}): Promise<T> {
  const token = signWorkerRlsContext(options.secret);
  return options.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT sgr_set_worker_context(${token})`;
    try {
      return await runWithRlsTransaction(tx, () => {
        const scoped = currentRlsTransaction();
        if (!scoped) {
          throw new Error('RLS transaction is not available');
        }
        return options.callback(scoped);
      });
    } finally {
      await tx.$executeRaw`SELECT sgr_clear_request_context()`.catch(() => undefined);
    }
  }, TX_OPTIONS);
}
