import { loadConfig, MissingConfigurationError } from '@sgr-registry/config';
import { startWorkerRuntime } from './runtime.js';

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

  await startWorkerRuntime({ listenHealth: true, installSignals: true });
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Worker failed to start';
  console.error(message);
  process.exit(1);
});
