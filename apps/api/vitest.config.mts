import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@sgr-registry/domain': resolve(import.meta.dirname, '../../packages/domain/src/index.ts'),
      '@sgr-registry/contracts': resolve(
        import.meta.dirname,
        '../../packages/contracts/src/index.ts',
      ),
      '@sgr-registry/config': resolve(import.meta.dirname, '../../packages/config/src/index.ts'),
    },
  },
});
