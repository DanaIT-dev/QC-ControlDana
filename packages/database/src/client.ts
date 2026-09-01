import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool, type PoolClient } from 'pg';
import { postgresUrlWithoutSchema } from './database-url';
import { serializePoolClientQueries } from './pg-query-queue';

function wrapPoolConnect(pool: Pool, decorate: (client: PoolClient) => Promise<PoolClient>): void {
  const originalConnect = pool.connect.bind(pool);
  pool.connect = ((
    callback?: (
      err: Error | undefined,
      client?: PoolClient,
      done?: (release?: unknown) => void,
    ) => void,
  ) => {
    const ready = originalConnect().then((client) => decorate(client));
    if (callback) {
      void ready.then(
        (client) => {
          callback(undefined, client, client.release.bind(client) as never);
        },
        (error: Error) => {
          callback(error);
        },
      );
      return undefined;
    }
    return ready;
  }) as Pool['connect'];
}

async function decoratePoolClient(client: PoolClient, assumeOwner: boolean): Promise<PoolClient> {
  serializePoolClientQueries(client);
  if (assumeOwner) {
    await client.query('SET ROLE sgr_owner');
  }
  return client;
}

function createClient(databaseUrl: string, assumeOwner: boolean): PrismaClient {
  const pool = new Pool({ connectionString: postgresUrlWithoutSchema(databaseUrl) });
  pool.on('error', () => undefined);
  wrapPoolConnect(pool, (client) => decoratePoolClient(client, assumeOwner));
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return createClient(databaseUrl, false);
}

export function createOwnerPrismaClient(databaseUrl: string): PrismaClient {
  return createClient(databaseUrl, true);
}

const clients = new Map<string, PrismaClient>();

function cacheKey(databaseUrl: string, assumeOwner: boolean): string {
  return `${assumeOwner ? 'owner' : 'runtime'}:${databaseUrl}`;
}

export function getPrismaClient(databaseUrl: string): PrismaClient {
  const key = cacheKey(databaseUrl, false);
  const existing = clients.get(key);
  if (existing) {
    return existing;
  }
  const created = createPrismaClient(databaseUrl);
  clients.set(key, created);
  return created;
}

export function getOwnerPrismaClient(databaseUrl: string): PrismaClient {
  const key = cacheKey(databaseUrl, true);
  const existing = clients.get(key);
  if (existing) {
    return existing;
  }
  const created = createOwnerPrismaClient(databaseUrl);
  clients.set(key, created);
  return created;
}

export async function disconnectPrismaClient(databaseUrl?: string): Promise<void> {
  if (databaseUrl) {
    const keys = [...clients.keys()].filter((key) => key.endsWith(`:${databaseUrl}`));
    await Promise.all(
      keys.map(async (key) => {
        const client = clients.get(key);
        if (client) {
          await client.$disconnect();
          clients.delete(key);
        }
      }),
    );
    return;
  }
  await Promise.all(
    [...clients.values()].map(async (client) => {
      await client.$disconnect();
    }),
  );
  clients.clear();
}
