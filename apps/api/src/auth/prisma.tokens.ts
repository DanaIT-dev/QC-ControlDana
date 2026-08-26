import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PrismaClient } from '@sgr-registry/database';
import type Redis from 'ioredis';
import { REDIS_CLIENT, RedisUnavailableError } from './redis.constants';

export const PRISMA_CLIENT = Symbol('PRISMA_CLIENT');

@Injectable()
export class PrismaService {
  constructor(@Inject(PRISMA_CLIENT) readonly client: PrismaClient) {}
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
