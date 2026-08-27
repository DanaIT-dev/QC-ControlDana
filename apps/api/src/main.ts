import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig, MissingConfigurationError } from '@sgr-registry/config';
import { AppModule } from './app.module';
import { configureHttpApp } from './configure-http';

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

  const adapter = new FastifyAdapter({
    logger: false,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.ATTACHMENT_MAX_BYTES + 1024 * 1024,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: ['error', 'warn', 'log'],
  });

  await configureHttpApp(app, config);
  await app.listen(config.API_PORT, config.API_HOST);
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'API failed to start';
  console.error(message);
  process.exit(1);
});
