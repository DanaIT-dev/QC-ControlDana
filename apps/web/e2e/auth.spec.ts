import { expect, test, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

const ACCOUNTS = {
  admin: {
    email: 'alexey.viktorov@example.sgr.local',
    name: 'Алексей Викторов',
    role: 'Администратор',
  },
  manager: {
    email: 'marina.sokolova@example.sgr.local',
    name: 'Марина Соколова',
    role: 'Руководитель СГР',
  },
};

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
}

test.describe('authentication browser flows', () => {
  test('anonymous root redirects to login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Реестр дефектных актов' })).toBeVisible();
  });

  test('ADMIN can sign in and open system status', async ({ page, context }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await login(page, ACCOUNTS.admin.email, DEMO_PASSWORD);
    await expect(page).toHaveURL(/\/registry$/);
    await expect(page.getByText(ACCOUNTS.admin.name)).toBeVisible();
    await expect(page.getByText(ACCOUNTS.admin.role)).toBeVisible();
    await page.getByRole('link', { name: 'Состояние системы' }).click();
    await expect(page).toHaveURL(/\/system-status$/);
    await expect(
      page.getByRole('heading', { name: 'Техническое состояние системы' }),
    ).toBeVisible();
    const localStorageKeys = await page.evaluate(() => Object.keys(window.localStorage));
    const sessionStorageKeys = await page.evaluate(() => Object.keys(window.sessionStorage));
    expect(localStorageKeys.join(' ')).not.toMatch(/token|session|password/i);
    expect(sessionStorageKeys.join(' ')).not.toMatch(/token|session|password/i);
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name === 'sgr_session');
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(errors).toEqual([]);
  });

  test('SGR_MANAGER cannot open system-status content', async ({ page }) => {
    await login(page, ACCOUNTS.manager.email, DEMO_PASSWORD);
    await expect(page).toHaveURL(/\/registry$/);
    await page.goto('/system-status');
    await expect(page.getByText('Недостаточно прав')).toBeVisible();
    await expect(page.getByText('PostgreSQL')).toHaveCount(0);
  });

  test('wrong password shows the generic error', async ({ page }) => {
    await login(page, ACCOUNTS.admin.email, 'Wrong-Password-2026!');
    await expect(page.locator('.form-error')).toHaveText('Неверный логин или пароль');
    await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Электронная почта')).toHaveValue(ACCOUNTS.admin.email);
  });

  test('logout returns to login and blocks registry', async ({ page }) => {
    await login(page, ACCOUNTS.admin.email, DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/registry');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('login form fits 390px without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login');
    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(overflow).toBe(false);
    await expect(page.locator('[data-login-backdrop]')).toBeVisible();
    const background = await page.locator('[data-login-backdrop]').evaluate((element) => {
      return getComputedStyle(element).backgroundImage;
    });
    expect(background).toContain('login-background.jpg');
    await expect(page.getByLabel('Электронная почта')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
  });
});
