import { defineConfig, devices } from '@playwright/test';
import { assertE2eDatabaseTarget } from './packages/database/src/e2e-target';

assertE2eDatabaseTarget(process.env);

const webOrigin = process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3200';
const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3201';
const workerHealth = `http://127.0.0.1:${process.env.WORKER_HEALTH_PORT ?? '3202'}/health`;
const pathPrefix = 'export PATH="$HOME/.local/bin:$PATH" && ';

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['list'], ['json', { outputFile: 'test-results/e2e/results.json' }]]
    : 'list',
  use: {
    baseURL: webOrigin,
    trace: 'on-first-retry',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  webServer: [
    {
      command: `${pathPrefix}pnpm --filter @sgr-registry/api dev`,
      url: `${apiOrigin}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `${pathPrefix}pnpm --filter @sgr-registry/worker dev`,
      url: workerHealth,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `${pathPrefix}pnpm --filter @sgr-registry/web exec -- next dev --port ${process.env.WEB_PORT ?? '3200'} -H 127.0.0.1`,
      url: `${webOrigin}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
