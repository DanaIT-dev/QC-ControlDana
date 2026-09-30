import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration-global.ts'],
    setupFiles: ['tests/integration-setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
  resolve: {
    alias: {
      '@sgr-registry/domain': resolve(import.meta.dirname, '../../packages/domain/src/index.ts'),
      '@sgr-registry/contracts': resolve(
        import.meta.dirname,
        '../../packages/contracts/src/index.ts',
      ),
      '@sgr-registry/config': resolve(import.meta.dirname, '../../packages/config/src/index.ts'),
      '@sgr-registry/jobs': resolve(import.meta.dirname, '../../packages/jobs/src/index.ts'),
    },
  },
});
