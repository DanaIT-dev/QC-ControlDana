import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@sgr-registry/domain': resolve(import.meta.dirname, '../domain/src/index.ts'),
    },
  },
});
