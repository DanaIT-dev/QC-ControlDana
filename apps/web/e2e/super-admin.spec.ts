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
    await expect(page).toHaveURL(/\/registry/);
    await page.goto('/super-admin');
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

test.describe('read-only SUPER_ADMIN oversight', () => {
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

  test('sees business data, creates pending users, grants and revokes ADMIN', async ({
    browser,
    page,
  }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await restoreManagerIfAdmin(page);
    await expect(page.getByRole('heading', { name: 'Администраторы', exact: true })).toBeVisible();
    await expect(page.getByText('Бизнес-данные реестра недоступны')).toHaveCount(0);
    await expect(page.getByText('Режим просмотра')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Реестр' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Справочники' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Пользователи' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Состояние системы' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Администраторы' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Создать акт' })).toHaveCount(0);
    await expect(page.getByText('Удалить администратора')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Снять права администратора' }).first(),
    ).toBeVisible();

    await page.goto('/registry');
    await expect(page).toHaveURL(/\/registry/);
    await expect(page.locator('.registry-table tbody tr').first()).toBeVisible();
    await page.locator('.registry-table tbody tr').first().click();
    await expect(page).toHaveURL(/\/acts\//);
    await expect(page.locator('.act-detail')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Отправить' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Загрузить' })).toHaveCount(0);
    await expect(page.getByLabel('Сообщение')).toHaveCount(0);

    await page.goto('/acts/new');
    await expect(page.getByText('Недостаточно прав для создания акта.')).toBeVisible();

    await page.goto('/users');
    await expect(page.getByRole('button', { name: 'Добавить пользователя' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Действия' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Добавить пользователя' }).click();
    await expect(page.getByRole('dialog').locator('#new-user-role')).toHaveCount(0);
    const stamp = Date.now();
    const pendingEmail = `e2e.pending.${stamp}@example.sgr.local`;
    await page.getByLabel('ФИО').fill(`Е2Е Без роли ${stamp}`);
    await page.getByLabel('Электронная почта').fill(pendingEmail);
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await expect(page.getByText('Временный пароль показывается один раз')).toBeVisible();
    const pendingPassword = (await page.locator('.temp-password').innerText()).trim();
    expect(pendingPassword.length).toBeGreaterThan(8);
    await page.getByRole('button', { name: 'Закрыть' }).click();

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);
    await login(page, pendingEmail, pendingPassword);
    await expect(page).toHaveURL(/\/change-password/);
    await page.getByLabel('Текущий пароль').fill(pendingPassword);
    await page.getByLabel('Новый пароль').fill('Dana-SGR-WaitRole-2026!');
    await page.getByRole('button', { name: 'Сменить пароль' }).click();
    await expect(page).toHaveURL(/\/pending-role/);
    await expect(
      page.getByText('Учетная запись создана. Ожидается назначение роли администратором'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Реестр' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await login(page, ADMIN_EMAIL);
    await expect(page).toHaveURL(/\/registry/);
    await page.getByRole('link', { name: 'Пользователи' }).click();
    await page.getByLabel('Поиск пользователей').fill(pendingEmail);
    const pendingRow = page.locator('tr').filter({ hasText: pendingEmail });
    await expect(pendingRow).toBeVisible();
    await pendingRow.getByRole('button', { name: 'Действия' }).click();
    await page.getByRole('menuitem', { name: 'Изменить роль' }).click();
    await page.getByRole('combobox', { name: 'Новая роль' }).click();
    await page.getByRole('option', { name: 'Руководитель СГР' }).click();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Изменения сохранены')).toBeVisible();

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await login(page, SUPER_ADMIN_EMAIL);
    await expect(page).toHaveURL(/\/registry/);
    await page.goto('/super-admin');

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
    await expect(page).toHaveURL(/\/registry/);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.goto('/registry');
      await noHorizontalOverflow(page);
      await page.goto('/super-admin');
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
