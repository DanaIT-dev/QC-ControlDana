import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@sgr-registry/contracts';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from './authenticated-user';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed || allowed.length === 0) {
      return true;
    }
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const role = request.user?.role;
    if (!role || !allowed.includes(role)) {
      throw new ForbiddenException('Недостаточно прав');
    }
    return true;
  }
}
