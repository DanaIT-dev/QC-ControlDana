import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ARTIFACTS = resolve(process.cwd(), 'test-results/visual');

const ACCOUNTS = {
  admin: 'alexey.viktorov@example.sgr.local',
  manager: 'marina.sokolova@example.sgr.local',
  contractor: 'igor.panteleev@example.sgr.local',
  responsible: 'dmitry.orlov@example.sgr.local',
};

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/registry/);
}

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

async function noAppErrors(errors: string[]) {
  const applicationErrors = errors.filter(
    (message) =>
      !message.includes('favicon') &&
      !message.includes('hydrated but some attributes') &&
      !message.includes('caret-color'),
  );
  expect(applicationErrors).toEqual([]);
}

test.describe('visual and responsive QA', () => {
  test.beforeAll(() => {
    mkdirSync(ARTIFACTS, { recursive: true });
  });

  test('login and registry across required viewports', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Реестр дефектных актов' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Войти' })).toBeEnabled();
    await page.screenshot({ path: `${ARTIFACTS}/login-desktop.png`, fullPage: true });
    await login(page, ACCOUNTS.admin);
    await expect(page.locator('.registry-table')).toBeVisible();
    const tableBox = await page.locator('.registry-table').boundingBox();
    expect(tableBox).toBeTruthy();
    expect((tableBox?.y ?? 9999) < 900).toBe(true);
    await page.screenshot({ path: `${ARTIFACTS}/registry-desktop-1440.png` });

    await page.getByRole('button', { name: 'Фильтры' }).click();
    await expect(page.getByRole('heading', { name: 'Фильтры' })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS}/registry-filters-open.png` });
    await page.getByRole('combobox', { name: 'Форма' }).click();
    const check = page.locator('[data-slot="option-check"]').first();
    await expect(check).toBeVisible();
    const box = await check.boundingBox();
    expect(box?.width ?? 99).toBeLessThanOrEqual(20);
    expect(box?.height ?? 99).toBeLessThanOrEqual(20);
    const option = page.getByRole('option').first();
    await expect(option).toBeVisible();
    const optionBox = await option.boundingBox();
    expect(optionBox?.height ?? 99).toBeLessThanOrEqual(48);
    await page.getByRole('option').nth(0).click();
    await page.getByRole('option').nth(1).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Показать результаты' }).click();
    await expect(page.locator('[data-slot="filter-chips"]')).toBeVisible();
    await page.getByRole('button', { name: 'Сбросить' }).click();
    await page.getByRole('button', { name: 'Фильтры' }).click();
    await page.getByRole('combobox', { name: 'Форма' }).click();
    await page.getByRole('option').first().click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Показать результаты' }).click();
    await expect(page.locator('[data-slot="filter-chips"]')).toBeVisible();
    await page
      .getByRole('button', { name: /Удалить фильтр/ })
      .first()
      .click();
    await expect(page.locator('[data-slot="filter-chips"]')).toHaveCount(0);

    await page.locator('.registry-table tbody tr').first().click();
    await expect(page).toHaveURL(/\/acts\//);
    await expect(page.locator('.act-detail')).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Акт / })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS}/act-detail-desktop.png`, fullPage: true });

    await page.getByRole('link', { name: 'Создать акт' }).click();
    await expect(page).toHaveURL(/\/acts\/new/);
    await expect(page.getByRole('heading', { name: 'Создание акта' })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS}/create-act-desktop.png`, fullPage: true });

    await page.getByRole('link', { name: 'Пользователи' }).click();
    await expect(page).toHaveURL(/\/users$/);
    await expect(page.getByRole('heading', { name: 'Пользователи' })).toBeVisible();
    await expect(page.locator('.data-table tbody tr').first()).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS}/users-desktop.png`, fullPage: true });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/registry');
    await noOverflow(page);
    await page.setViewportSize({ width: 1024, height: 768 });
    await noOverflow(page);
    await page.setViewportSize({ width: 768, height: 1024 });
    await noOverflow(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/registry');
    await expect(page.locator('.defect-card').first()).toBeVisible();
    await expect(page.locator('.registry-table')).toHaveCount(0);
    await noOverflow(page);
    await page.screenshot({ path: `${ARTIFACTS}/registry-390.png`, fullPage: true });
    await page.locator('.defect-card').first().getByRole('button', { name: 'Открыть' }).click();
    await expect(page.locator('.act-detail')).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Акт / })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS}/act-detail-390.png`, fullPage: true });
    await noOverflow(page);

    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/change-password');
    await expect(page).toHaveURL(/\/change-password/);
    await expect(page.getByLabel('Текущий пароль')).toBeVisible();
    await noOverflow(page);
    await page.goto('/registry');
    await noOverflow(page);
    await noAppErrors(errors);
  });

  test('role pages for remaining accounts', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.manager);
    await expect(page.getByRole('link', { name: 'Пользователи' })).toHaveCount(0);
    await page.goto('/system-status');
    await expect(page.getByText('Недостаточно прав')).toBeVisible();

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await login(page, ACCOUNTS.contractor);
    await expect(page.getByText('Сумма предложений А')).toHaveCount(0);

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await login(page, ACCOUNTS.responsible);
    await expect(page.getByRole('button', { name: /предложения B и C/ })).toHaveCount(0);
  });
});
