import { expect, test, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

const ACCOUNTS = {
  admin: { email: 'alexey.viktorov@example.sgr.local', systemStatus: true },
  manager: { email: 'marina.sokolova@example.sgr.local', systemStatus: false },
  responsible: { email: 'dmitry.orlov@example.sgr.local', systemStatus: false },
  contractor: { email: 'igor.panteleev@example.sgr.local', systemStatus: false },
} as const;

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/registry/);
}

test.describe('web security headers and role surfaces', () => {
  test('login publishes CSP and denies framing without page errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const response = await page.goto('/login');
    expect(response?.ok()).toBeTruthy();
    const headers = response?.headers() ?? {};
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(headers['x-frame-options']?.toLowerCase()).toBe('deny');
    expect(headers['x-content-type-options']).toBe('nosniff');
    await expect(page.getByRole('heading', { name: 'Реестр дефектных актов' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('authenticated roles can open product pages without XSS from search', async ({ page }) => {
    test.setTimeout(120_000);
    for (const account of Object.values(ACCOUNTS)) {
      const errors: string[] = [];
      const onError = (error: Error) => errors.push(error.message);
      page.on('pageerror', onError);
      await login(page, account.email);
      await page.goto('/notifications');
      await expect(page).toHaveURL(/\/notifications/);
      await page.goto('/deadlines');
      await expect(page).toHaveURL(/\/deadlines/);
      await page.goto('/system-status');
      if (account.systemStatus) {
        await expect(
          page.getByRole('heading', { name: 'Техническое состояние системы' }),
        ).toBeVisible();
      } else {
        await expect(page.getByText('Недостаточно прав')).toBeVisible();
      }
      await page.goto('/registry');
      await page
        .getByPlaceholder('Номер акта, объект, адрес, заказчик…')
        .fill('<script>alert(1)</script>');
      await page.getByPlaceholder('Номер акта, объект, адрес, заказчик…').press('Enter');
      await expect(page.locator('script', { hasText: 'alert(1)' })).toHaveCount(0);
      const localStorageKeys = await page.evaluate(() => Object.keys(window.localStorage));
      expect(localStorageKeys.join(' ')).not.toMatch(/token|session|password/i);
      await page.getByRole('button', { name: 'Меню пользователя' }).click();
      await page.getByRole('menuitem', { name: 'Выйти' }).click();
      await expect(page).toHaveURL(/\/login/);
      page.off('pageerror', onError);
      expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
    }
  });
});
