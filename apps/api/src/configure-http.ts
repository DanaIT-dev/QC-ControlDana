import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from '@sgr-registry/config';
import {
  JSON_BODY_MAX_BYTES,
  PERMISSIONS_POLICY,
  isMultipartUploadRoute,
} from './common/http-limits.js';

export async function configureHttpApp(
  app: NestFastifyApplication,
  config: AppConfig,
): Promise<void> {
  await app.register(helmet as never, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    hsts:
      config.NODE_ENV === 'production' ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });
  await app.register(cookie as never);
  await app.register(multipart as never, {
    limits: { files: 1, fileSize: config.ATTACHMENT_MAX_BYTES },
    attachFieldsToBody: false,
  });

  app.enableCors({
    origin: config.WEB_ORIGIN,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id'],
  });
  app.setGlobalPrefix('api');

  const fastify = app.getHttpAdapter().getInstance();
  const uploadBodyLimit = config.ATTACHMENT_MAX_BYTES + 1024 * 1024;
  fastify.addHook('onRoute', (routeOptions) => {
    const url = routeOptions.url ?? '';
    routeOptions.bodyLimit = isMultipartUploadRoute(url) ? uploadBodyLimit : JSON_BODY_MAX_BYTES;
  });
  fastify.addHook('onRequest', async (request, reply) => {
    const header = request.headers['x-request-id'];
    const requestId =
      typeof header === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(header) ? header : randomUUID();
    Object.assign(request, { requestId });
    reply.header('x-request-id', requestId);
    reply.header('Permissions-Policy', PERMISSIONS_POLICY);
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.includes('multipart/form-data')) {
      const length = Number(request.headers['content-length'] ?? 0);
      if (Number.isFinite(length) && length > JSON_BODY_MAX_BYTES) {
        return reply.code(413).send({ statusCode: 413, message: 'Payload Too Large' });
      }
    }
  });
}
