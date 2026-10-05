import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { SESSION_COOKIE_NAME } from '@sgr-registry/domain';
import type { AuthenticatedUser } from './authenticated-user.js';
import { AuthService } from './auth.service.js';
import { RedisUnavailableError } from './redis.constants.js';

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
      if (request.user.mustChangePassword && !isPasswordChangeAllowed(request.url)) {
        throw new ForbiddenException('Необходимо сменить временный пароль');
      }
      if (
        request.user.mustCompleteProfile &&
        !request.user.mustChangePassword &&
        !isProfileCompletionAllowed(request.url)
      ) {
        throw new ForbiddenException('Заполните карточку сотрудника');
      }
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof ForbiddenException) {
        throw error;
      }
      if (error instanceof RedisUnavailableError) {
        throw new UnauthorizedException('Требуется авторизация');
      }
      throw new UnauthorizedException('Требуется авторизация');
    }
  }
}

function isPasswordChangeAllowed(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return /\/auth\/(me|capabilities|logout|logout-all|change-password)$/.test(path);
}

function isProfileCompletionAllowed(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return (
    /\/auth\/(me|capabilities|logout|logout-all|change-password)$/.test(path) ||
    /\/users\/me\/complete-profile$/.test(path)
  );
}
