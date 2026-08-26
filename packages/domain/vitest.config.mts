import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@sgr-registry/contracts': resolve(import.meta.dirname, '../contracts/src/index.ts'),
    },
  },
});
