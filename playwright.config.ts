import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  use: {
    baseURL: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'export PATH="$HOME/.local/bin:$PATH" && pnpm --filter @sgr-registry/api dev',
      url: 'http://localhost:3001/api/health',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'export PATH="$HOME/.local/bin:$PATH" && pnpm --filter @sgr-registry/worker dev',
      url: 'http://127.0.0.1:3002/health',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'export PATH="$HOME/.local/bin:$PATH" && pnpm --filter @sgr-registry/web dev',
      url: 'http://localhost:3000/login',
      reuseExistingServer: true,
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
