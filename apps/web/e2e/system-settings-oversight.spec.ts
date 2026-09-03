import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { clickAdminNavItem } from './nav';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ADMIN = 'alexey.viktorov@example.sgr.local';
const SUPER_ADMIN = 'super.admin@example.sgr.local';

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
}

test.describe('system settings oversight', () => {
  test.beforeAll(() => {
    const result = spawnSync(
      'pnpm',
      ['--filter', '@sgr-registry/database', 'exec', 'tsx', 'scripts/ensure-test-super-admin.ts'],
      { cwd: resolve(process.cwd()), encoding: 'utf8', env: process.env },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'Failed to provision test SUPER_ADMIN');
    }
  });

  test('SUPER_ADMIN sees read-only notification settings without save action', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, SUPER_ADMIN);
    await expect(page).toHaveURL(/\/registry/);
    await clickAdminNavItem(page, 'Состояние системы');
    await expect(page.getByText('Настройки уведомлений')).toBeVisible();
    const readonly = page.locator('[data-slot="notification-settings-readonly"]');
    await expect(readonly).toBeVisible();
    await expect(readonly.getByText('Дней до предупреждения')).toBeVisible();
    await expect(readonly.getByText('Пороги эскалации (дни)')).toBeVisible();
    await expect(readonly.getByText('Ежедневная проверка (Europe/Minsk)')).toBeVisible();
    await expect(readonly.getByText(/Email-уведомления/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Сохранить настройки' })).toHaveCount(0);
    await expect(page.locator('#warning-days')).toHaveCount(0);
  });

  test('ADMIN keeps editable notification settings', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN);
    await expect(page).toHaveURL(/\/registry/);
    await page.goto('/system-status');
    await expect(page.getByText('Настройки уведомлений')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Сохранить настройки' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('#warning-days')).toBeVisible();
    await expect(page.locator('[data-slot="notification-settings-readonly"]')).toHaveCount(0);
  });
});
