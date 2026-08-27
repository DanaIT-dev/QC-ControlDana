import { SetMetadata } from '@nestjs/common';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasCapability, type Capability } from '@sgr-registry/domain';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user';

export const CAPABILITY_KEY = 'sgr:capability';

export const RequireCapability = (...capabilities: Capability[]) =>
  SetMetadata(CAPABILITY_KEY, capabilities);

@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Capability[]>(CAPABILITY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const role = request.user?.role;
    if (!role || !required.some((capability) => hasCapability(role, capability))) {
      throw new ForbiddenException('Недостаточно прав');
    }
    return true;
  }
}
