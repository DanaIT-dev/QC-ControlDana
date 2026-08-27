import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, '.'),
      '@sgr-registry/contracts': resolve(
        import.meta.dirname,
        '../../packages/contracts/src/index.ts',
      ),
      '@sgr-registry/domain': resolve(import.meta.dirname, '../../packages/domain/src/index.ts'),
    },
  },
});
