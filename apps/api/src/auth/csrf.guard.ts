import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CSRF_HEADER_NAME } from '@sgr-registry/domain';
import type { AuthenticatedUser } from './authenticated-user';
import { safeEqual } from './crypto';

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const header = request.headers[CSRF_HEADER_NAME];
    const token = Array.isArray(header) ? header[0] : header;
    const expected = request.user?.csrfToken;
    if (!token || !expected || !safeEqual(token, expected)) {
      throw new ForbiddenException('Запрос отклонён');
    }
    return true;
  }
}
