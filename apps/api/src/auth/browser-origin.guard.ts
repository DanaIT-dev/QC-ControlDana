import { ForbiddenException, Injectable } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import type { FastifyRequest } from 'fastify';
import { CanActivate, type ExecutionContext } from '@nestjs/common';
import { isAllowedBrowserSource } from './request-meta';

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

@Injectable()
export class BrowserOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const config = loadConfig();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const origin = headerValue(request.headers.origin);
    const referer = headerValue(request.headers.referer ?? request.headers['referrer']);
    if (!isAllowedBrowserSource(origin, referer, config.WEB_ORIGIN)) {
      throw new ForbiddenException('Запрос отклонён');
    }
    return true;
  }
}
