import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const SUPER_ADMIN_EMAIL = 'super.admin@example.sgr.local';
const ADMIN_EMAIL = 'alexey.viktorov@example.sgr.local';
const MANAGER_EMAIL = 'marina.sokolova@example.sgr.local';
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 360, height: 800 },
  { width: 768, height: 1024 },
] as const;

async function login(page: Page, email: string, password = DEMO_PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

async function restoreManagerIfAdmin(page: Page) {
  await page.goto('/super-admin');
  if (/\/login/.test(new URL(page.url()).pathname)) {
    await page.getByLabel('Электронная почта').fill(SUPER_ADMIN_EMAIL);
    await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
  }
  await expect(page).toHaveURL(/\/super-admin/);
  const revoke = page.locator('li').filter({ hasText: MANAGER_EMAIL }).getByRole('button', {
    name: 'Снять права администратора',
  });
  if ((await revoke.count()) === 0) {
    return;
  }
  await revoke.click();
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByText('Права администратора сняты')).toBeVisible();
}

test.describe('isolated SUPER_ADMIN', () => {
  test.beforeAll(() => {
    const result = spawnSync(
      'pnpm',
      ['--filter', '@sgr-registry/database', 'exec', 'tsx', 'scripts/ensure-test-super-admin.ts'],
      {
        cwd: resolve(process.cwd()),
        encoding: 'utf8',
        env: process.env,
      },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'Failed to provision test SUPER_ADMIN');
    }
  });

  test('logs in, isolates navigation, grants and revokes ADMIN', async ({ browser, page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await restoreManagerIfAdmin(page);
    await expect(page.getByRole('heading', { name: 'Администраторы', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Реестр' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Справочники' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Пользователи' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Состояние системы' })).toHaveCount(0);
    await expect(page.getByText('Удалить администратора')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Снять права администратора' }).first(),
    ).toBeVisible();

    await page.goto('/registry');
    await expect(page).toHaveURL(/\/super-admin/);
    await page.goto('/reference-data');
    await expect(page).toHaveURL(/\/super-admin/);
    await page.goto('/history');
    await expect(page).toHaveURL(/\/super-admin/);
    await page.goto('/acts/11111111-1111-4111-8111-111111111111');
    await expect(page).toHaveURL(/\/super-admin/);

    const revokeButtons = page.getByRole('button', { name: 'Снять права администратора' });
    if ((await revokeButtons.count()) === 1) {
      await revokeButtons.click();
      await expect(
        page.getByRole('heading', { name: 'Нельзя снять права последнего администратора' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Понятно' }).click();
    }

    const managerContext = await browser.newContext();
    const managerPage = await managerContext.newPage();
    try {
      await login(managerPage, MANAGER_EMAIL);
      await expect(managerPage).toHaveURL(/\/registry/);

      await page.getByLabel('Поиск сотрудников').fill('marina.sokolova');
      const eligible = page.locator('li').filter({ hasText: MANAGER_EMAIL });
      await expect(
        eligible.getByRole('button', { name: 'Назначить администратором' }),
      ).toBeVisible();
      await eligible.getByRole('button', { name: 'Назначить администратором' }).click();
      await page.getByRole('button', { name: 'Подтвердить' }).click();
      await expect(page.getByText('Права администратора назначены')).toBeVisible();

      await managerPage.reload();
      await expect(managerPage).toHaveURL(/\/login/);
      await login(managerPage, MANAGER_EMAIL);
      await expect(managerPage).toHaveURL(/\/registry/);
      await expect(managerPage.getByText('Администратор')).toBeVisible();

      const granted = page.locator('li').filter({ hasText: MANAGER_EMAIL });
      await granted.getByRole('button', { name: 'Снять права администратора' }).click();
      await page.getByRole('button', { name: 'Подтвердить' }).click();
      await expect(page.getByText('Права администратора сняты')).toBeVisible();
    } finally {
      await managerContext.close();
      await restoreManagerIfAdmin(page);
    }

    const restored = await browser.newContext();
    const restoredPage = await restored.newPage();
    try {
      await login(restoredPage, MANAGER_EMAIL);
      await expect(restoredPage).toHaveURL(/\/registry/);
      await expect(restoredPage.getByText('Руководитель СГР')).toBeVisible();
    } finally {
      await restored.close();
    }

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await expect(page.getByRole('menuitem', { name: 'Сменить пароль' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);

    await login(page, ADMIN_EMAIL);
    await expect(page).toHaveURL(/\/registry/);
    await page.getByRole('link', { name: 'Пользователи' }).click();
    await page.getByRole('button', { name: 'Добавить пользователя' }).click();
    await page.getByRole('dialog').locator('#new-user-role').click();
    const options = await page.getByRole('option').allTextContents();
    expect(options.join(' ')).not.toMatch(/Администратор|Суперадминистратор/);
    expect(options).toEqual(
      expect.arrayContaining([
        'Руководитель СГР',
        'Ответственный инженер',
        'Инженер по работе с подрядчиками',
      ]),
    );
    expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
  });

  test('fits required viewports without overflow', async ({ page }) => {
    await login(page, SUPER_ADMIN_EMAIL);
    await expect(page).toHaveURL(/\/super-admin/);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await noHorizontalOverflow(page);
      await expect(
        page.getByRole('heading', { name: 'Администраторы', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Снять права администратора' }).first(),
      ).toBeVisible();
    }
  });
});
