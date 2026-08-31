import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { AuthenticatedUser } from './authenticated-user';
import { PrismaService } from './prisma.tokens';
import { SKIP_RLS_TRANSACTION } from './skip-rls-transaction';

@Injectable()
export class RlsContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RLS_TRANSACTION, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const user = request.user;
    if (skip || !user) {
      return next.handle();
    }
    return from(this.prisma.withUser(user, request, () => lastValueFrom(next.handle())));
  }
}
