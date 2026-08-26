import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadConfig, MissingConfigurationError } from '@sgr-registry/config';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  try {
    loadConfig();
  } catch (error) {
    if (error instanceof MissingConfigurationError) {
      console.error(error.message);
      console.error(`Missing or invalid keys: ${error.missingKeys.join(', ')}`);
      process.exit(1);
    }
    throw error;
  }

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Worker failed to start';
  console.error(message);
  process.exit(1);
});
