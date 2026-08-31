import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import {
  prismaWithRlsTransaction,
  withAuthenticatedDbContext,
  type PrismaClient,
} from '@sgr-registry/database';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from './authenticated-user';
import { requestIdOf } from '../common/request-context';
import { REDIS_CLIENT, RedisUnavailableError } from './redis.constants';
import type Redis from 'ioredis';

export const PRISMA_CLIENT = Symbol('PRISMA_CLIENT');
export const AUTH_PRISMA_CLIENT = Symbol('AUTH_PRISMA_CLIENT');

@Injectable()
export class PrismaService {
  constructor(@Inject(PRISMA_CLIENT) private readonly root: PrismaClient) {}

  get client(): PrismaClient {
    return prismaWithRlsTransaction(this.root);
  }

  withUser<T>(
    user: Pick<AuthenticatedUser, 'id' | 'sessionVersion'>,
    request: FastifyRequest | null | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const headerId = request ? requestIdOf(request) : null;
    return withAuthenticatedDbContext({
      prisma: this.root,
      secret: loadConfig().RLS_CONTEXT_SECRET,
      user: { id: user.id, sessionVersion: user.sessionVersion },
      nonce: headerId ?? randomUUID(),
      callback: () => fn(),
    });
  }
}

export function failClosed(): never {
  throw new UnauthorizedException('Требуется авторизация');
}

export function serviceUnavailable(): never {
  throw new ServiceUnavailableException('Сервис временно недоступен');
}

export function rethrowStoreError(error: unknown): never {
  if (error instanceof RedisUnavailableError) {
    serviceUnavailable();
  }
  throw error;
}

export function rethrowStoreErrorAsUnauthorized(error: unknown): never {
  if (error instanceof RedisUnavailableError) {
    failClosed();
  }
  throw error;
}

export { REDIS_CLIENT };
export type { Redis };
