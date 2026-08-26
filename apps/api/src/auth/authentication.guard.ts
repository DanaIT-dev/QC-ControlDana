import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { SESSION_COOKIE_NAME } from '@sgr-registry/domain';
import type { AuthenticatedUser } from './authenticated-user';
import { AuthService } from './auth.service';
import { RedisUnavailableError } from './redis.constants';

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<
        FastifyRequest & { user?: AuthenticatedUser; cookies?: Record<string, string> }
      >();
    const sessionId = request.cookies?.[SESSION_COOKIE_NAME];
    if (!sessionId) {
      throw new UnauthorizedException('Требуется авторизация');
    }

    try {
      request.user = await this.authService.resolveSession(sessionId, request);
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      if (error instanceof RedisUnavailableError) {
        throw new UnauthorizedException('Требуется авторизация');
      }
      throw new UnauthorizedException('Требуется авторизация');
    }
  }
}
