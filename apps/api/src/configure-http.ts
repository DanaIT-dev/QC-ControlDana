import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from '@sgr-registry/config';

export async function configureHttpApp(
  app: NestFastifyApplication,
  config: AppConfig,
): Promise<void> {
  await app.register(helmet as never, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
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
  fastify.addHook('onRequest', async (request, reply) => {
    const header = request.headers['x-request-id'];
    const requestId = typeof header === 'string' && header.length > 0 ? header : randomUUID();
    Object.assign(request, { requestId });
    reply.header('x-request-id', requestId);
  });
}
