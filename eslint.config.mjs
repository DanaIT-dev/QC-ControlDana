import sgrRegistryConfig from '@sgr-registry/eslint-config';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.next-e2e/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/database/src/generated/**',
      'packages/database/prisma/migrations/**',
      'apps/web/next-env.d.ts',
      'scripts/**',
    ],
  },
  ...sgrRegistryConfig,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
