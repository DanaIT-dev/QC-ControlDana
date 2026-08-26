import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig, MissingConfigurationError } from '@sgr-registry/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof MissingConfigurationError) {
      console.error(error.message);
      console.error(`Missing or invalid keys: ${error.missingKeys.join(', ')}`);
      process.exit(1);
    }
    throw error;
  }

  const adapter = new FastifyAdapter({ logger: false, requestIdHeader: 'x-request-id' });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: ['error', 'warn', 'log'],
  });

  app.enableCors({ origin: config.WEB_ORIGIN });
  app.setGlobalPrefix('api');

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', async (request, reply) => {
    const header = request.headers['x-request-id'];
    const requestId = typeof header === 'string' && header.length > 0 ? header : randomUUID();
    request.headers['x-request-id'] = requestId;
    reply.header('x-request-id', requestId);
  });

  await app.listen(config.API_PORT, config.API_HOST);
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'API failed to start';
  console.error(message);
  process.exit(1);
});
