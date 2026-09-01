import type { Prisma, PrismaClient } from '@prisma/client';

type CredentialClient = {
  userCredential: {
    upsert: PrismaClient['userCredential']['upsert'];
  };
};

export async function upsertUserCredentials(
  prisma: CredentialClient,
  input: { userId: string; passwordHash: string; passwordChangedAt?: Date },
): Promise<void> {
  const now = input.passwordChangedAt ?? new Date();
  await prisma.userCredential.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      passwordHash: input.passwordHash,
      passwordChangedAt: now,
    },
    update: {
      passwordHash: input.passwordHash,
      passwordChangedAt: now,
    },
  });
}

export async function upsertUserCredentialsViaDefiner(
  tx: { $executeRaw: Prisma.TransactionClient['$executeRaw'] },
  input: { userId: string; passwordHash: string },
): Promise<void> {
  await tx.$executeRaw`
    SELECT public.sgr_upsert_user_credentials(
      ${input.userId}::uuid,
      ${input.passwordHash}
    )`;
}

export async function createUserWithPassword(
  prisma: PrismaClient,
  data: Prisma.UserCreateInput & { passwordHash: string },
) {
  const { passwordHash, ...userData } = data;
  const user = await prisma.user.create({ data: userData });
  await upsertUserCredentials(prisma, { userId: user.id, passwordHash });
  return { ...user, passwordHash };
}
