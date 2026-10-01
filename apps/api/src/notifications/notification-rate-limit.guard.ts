import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { loadConfig } from '@sgr-registry/config';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { REDIS_CLIENT } from '../auth/redis.constants.js';

@Injectable()
export class NotificationMutationRateLimitGuard implements CanActivate {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const userId = request.user?.id;
    if (!userId) {
      return true;
    }
    const config = loadConfig();
    const key = `${config.REDIS_KEY_PREFIX}:rl:notifications:${userId}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, 60);
    }
    if (count > 40) {
      throw new HttpException('Слишком много запросов', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
