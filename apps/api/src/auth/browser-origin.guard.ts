import { ForbiddenException, Injectable } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import type { FastifyRequest } from 'fastify';
import { CanActivate, type ExecutionContext } from '@nestjs/common';
import { isAllowedOrigin } from './request-meta';

@Injectable()
export class BrowserOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const config = loadConfig();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const originHeader = request.headers.origin;
    const origin = typeof originHeader === 'string' ? originHeader : undefined;
    if (!isAllowedOrigin(origin, config.WEB_ORIGIN)) {
      throw new ForbiddenException('Запрос отклонён');
    }
    return true;
  }
}
