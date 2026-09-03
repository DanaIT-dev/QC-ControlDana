import {
  ForbiddenException,
  Injectable,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import type { AuthenticatedUser } from '../auth/authenticated-user';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED: Array<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/api\/auth\/(login|change-password|logout|logout-all)\/?$/ },
  { method: 'POST', pattern: new RegExp(`^/api/super-admin/admins/${UUID}/?$`, 'i') },
  { method: 'DELETE', pattern: new RegExp(`^/api/super-admin/admins/${UUID}/?$`, 'i') },
  { method: 'POST', pattern: /^\/api\/super-admin\/users\/?$/ },
  { method: 'PATCH', pattern: new RegExp(`^/api/users/${UUID}/profile/?$`, 'i') },
  { method: 'PATCH', pattern: new RegExp(`^/api/users/${UUID}/?$`, 'i') },
];

@Injectable()
export class SuperAdminReadOnlyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const role = request.user?.role;
    if (role !== 'SUPER_ADMIN') {
      return next.handle();
    }
    const method = request.method.toUpperCase();
    if (!MUTATING.has(method)) {
      return next.handle();
    }
    const raw = (request.url ?? '').split('?')[0] ?? '';
    const path = raw.startsWith('/api/') ? raw : `/api${raw.startsWith('/') ? raw : `/${raw}`}`;
    if (ALLOWED.some((rule) => rule.method === method && rule.pattern.test(path))) {
      return next.handle();
    }
    throw new ForbiddenException('Недостаточно прав');
  }
}
