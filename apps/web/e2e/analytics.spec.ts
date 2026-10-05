import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectPrimaryNavItem } from './nav';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ACCOUNTS = {
  admin: 'alexey.viktorov@example.sgr.local',
  manager: 'olga.romanova@example.sgr.local',
  sgrManager: 'marina.sokolova@example.sgr.local',
  responsible: 'dmitry.orlov@example.sgr.local',
  contractor: 'igor.panteleev@example.sgr.local',
  superAdmin: 'super.admin@example.sgr.local',
  pending: 'pending.role@example.sgr.local',
} as const;

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 375, height: 812 },
  { width: 360, height: 800 },
] as const;

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe('quality analytics', () => {
  test.beforeAll(() => {
    const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? '';
    expect(databaseUrl).toContain('sgr_registry_e2e');
    const result = spawnSync(
      'pnpm',
      [
        '--filter',
        '@sgr-registry/database',
        'exec',
        'tsx',
        'scripts/prepare-e2e-analytics-signal.ts',
      ],
      {
        encoding: 'utf8',
        cwd: resolve(__dirname, '../../..'),
        env: process.env,
      },
    );
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  });

  test('admin keeps filters and can open the section', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await expect(page).toHaveURL(/\/registry/);
    await expectPrimaryNavItem(page, 'Аналитика', true);
    await page.goto('/analytics');
    await expect(page.getByRole('heading', { name: 'Аналитика' })).toBeVisible();
    await page.getByLabel('Дата регистрации с').fill('2026-01-01');
    await page.getByLabel('Дата регистрации по').fill('2026-09-30');
    await expect(page).toHaveURL(/dateFrom=2026-01-01/);
    await page.reload();
    await expect(page.getByLabel('Дата регистрации с')).toHaveValue('2026-01-01');
    await page.getByRole('tab', { name: 'Паттерны' }).click();
    await page.getByRole('tab', { name: 'Качество данных' }).click();
    await expect(async () => {
      if (
        (await page.getByRole('tab', { name: 'Обзор' }).getAttribute('data-state')) !== 'active'
      ) {
        await page.getByRole('tab', { name: 'Обзор' }).click();
      }
      await expect(page.getByRole('tab', { name: 'Обзор' })).toHaveAttribute(
        'data-state',
        'active',
      );
      await expect(page.locator('[data-analytics-ready="true"]')).toBeVisible();
      await expect(
        page.getByRole('button', { name: /Подтверждённая финансовая нагрузка/ }),
      ).toContainText('Нет подтверждённых данных');
      await expect(
        page.getByRole('button', { name: /Риск-взвешенный открытый долг/ }),
      ).toContainText('Недостаточно подтверждённых финансовых данных');
    }).toPass();
    await page.screenshot({
      path: 'test-results/analytics-hardening/admin-overview.png',
      fullPage: true,
    });
    expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
  });

  for (const viewport of VIEWPORTS) {
    test(`admin analytics has no page overflow at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await login(page, ACCOUNTS.admin);
      await page.goto('/analytics');
      await expect(page.getByRole('heading', { name: 'Аналитика' })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflow).toBe(false);
      await expect(page.locator('[data-analytics-ready="true"]')).toBeVisible();
      await page.screenshot({
        path: `test-results/analytics-hardening/admin-${viewport.width}x${viewport.height}.png`,
        fullPage: true,
      });
    });
  }

  test('zoomed desktop does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await page.goto('/analytics');
    await expect(page.locator('[data-analytics-ready="true"]')).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1.25';
    });
    await page.screenshot({
      path: 'test-results/analytics-hardening/zoom-125.png',
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1.5';
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);
    await page.screenshot({
      path: 'test-results/analytics-hardening/zoom-150.png',
      fullPage: true,
    });
  });

  test('contractor does not see finance or review actions', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.contractor);
    await page.goto('/analytics');
    await expect(page.getByRole('heading', { name: 'Аналитика' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Финансы' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Паттерны' }).click();
    await expect(page.getByRole('button', { name: 'Подтвердить' })).toHaveCount(0);
    await expect(page.getByText('Подтверждённая финансовая нагрузка')).toHaveCount(0);
    await page.screenshot({
      path: 'test-results/analytics-hardening/contractor.png',
      fullPage: true,
    });
  });

  test('super admin has no mutation actions', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, ACCOUNTS.superAdmin);
    await page.goto('/analytics');
    await expect(page.getByRole('heading', { name: 'Аналитика' })).toBeVisible();
    await page.getByRole('tab', { name: 'Паттерны' }).click();
    await expect(page.getByRole('button', { name: 'Подтвердить' })).toHaveCount(0);
    await page.screenshot({
      path: 'test-results/analytics-hardening/super-admin.png',
      fullPage: true,
    });
  });

  test('pending role does not get the section', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.superAdmin);
    await page.goto('/users');
    await page.getByRole('button', { name: 'Добавить пользователя' }).click();
    const pendingEmail = `e2e.analytics.pending.${Date.now()}@example.sgr.local`;
    await page.getByLabel('Фамилия').fill('Аналитика');
    await page.getByLabel('Имя').fill('Ожидание');
    await page.getByLabel('Электронная почта').fill(pendingEmail);
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    const pendingPassword = (await page.locator('.temp-password').innerText()).trim();
    await page.getByRole('button', { name: 'Закрыть' }).click();
    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await page.goto('/login');
    await page.getByLabel('Электронная почта').fill(pendingEmail);
    await page.getByLabel('Пароль', { exact: true }).fill(pendingPassword);
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.getByLabel('Текущий пароль').fill(pendingPassword);
    await page.getByLabel('Новый пароль').fill('Dana-SGR-WaitRole-2026!');
    await page.getByRole('button', { name: 'Сменить пароль' }).click();
    await expect(page).toHaveURL(/\/pending-role/);
    await page.goto('/analytics');
    await expect(page).not.toHaveURL(/\/analytics/);
    await expect(page.getByRole('heading', { name: 'Аналитика' })).toHaveCount(0);
  });

  for (const [role, email] of [
    ['manager', ACCOUNTS.manager],
    ['sgr', ACCOUNTS.sgrManager],
    ['responsible', ACCOUNTS.responsible],
  ] as const) {
    test(`${role} can open analytics`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page, email);
      await page.goto('/analytics');
      await expect(page.getByRole('heading', { name: 'Аналитика' })).toBeVisible();
      await expect(page.locator('[data-analytics-ready="true"]')).toBeVisible();
      await page.screenshot({
        path: `test-results/analytics-hardening/${role}.png`,
        fullPage: true,
      });
    });
  }

  test('admin opens only the defects that formed a low first-time-right signal', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await page.goto('/analytics?dateFrom=2026-01-01');
    await expect(page.locator('[data-analytics-ready="true"]')).toBeVisible();
    const exposure = page.getByRole('button', { name: /Подтверждённая финансовая нагрузка/ });
    await expect(exposure).toHaveAttribute('title', /ACTUAL_COST/);
    const backlog = page.getByRole('button', { name: /Риск-взвешенный открытый долг/ });
    await expect(backlog).toHaveAttribute('title', /Формула 2026\.10\.05\.2/);
    await page.getByRole('tab', { name: 'Качество данных' }).click();
    await expect(
      page.getByText('Метрика недоступна: система пока не фиксирует необходимое событие'),
    ).toHaveCount(2);
    await page.getByRole('tab', { name: 'Паттерны' }).click();
    await expect(page.getByRole('tab', { name: 'Паттерны' })).toHaveAttribute(
      'data-state',
      'active',
    );
    const signal = page
      .locator('[data-slot="card"]')
      .filter({ hasText: 'доля принятия с первой попытки 0.0%' });
    await expect(signal).toHaveCount(1);
    await expect(signal).toContainText('Выборка: 6.');
    await signal.getByRole('button', { name: 'Показать исходные дефекты' }).click();
    await expect(page).toHaveURL(/tab=drilldown/);
    await expect(page).toHaveURL(/insightId=/);
    await expect(
      page.getByRole('heading', { name: 'First-Time-Right ниже базового уровня' }),
    ).toBeVisible();
    await expect(page.getByText('Выборка: 6. Правило 2026.10.05.2')).toBeVisible();
    await expect(page.getByRole('link', { name: /Акт / })).toHaveCount(6);
    await expect(page.getByText('baseline-0')).toHaveCount(0);
    const mainText = await page.locator('main').innerText();
    expect(mainText).not.toMatch(/undefined|NaN|Infinity/);
    expect(mainText).not.toMatch(/@/);
    await page.screenshot({
      path: 'test-results/analytics-hardening/signal-support.png',
      fullPage: true,
    });
    await page.getByRole('link', { name: /Акт / }).first().click();
    await expect(page).toHaveURL(/\/acts\//);
    await page.goBack();
    await expect(page).toHaveURL(/dateFrom=2026-01-01/);
    await expect(page).toHaveURL(/insightId=/);
    await expect(page.getByText('Выборка: 6. Правило 2026.10.05.2')).toBeVisible();
  });

  test('contractor does not see the other organization', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, ACCOUNTS.contractor);
    await page.goto('/analytics');
    await expect(page.locator('[data-analytics-ready="true"]')).toBeVisible();
    await expect(page.getByText('ООО «Оконные системы Бел» (демо)')).toHaveCount(0);
    await expect(page.getByText('Подтверждённая финансовая нагрузка')).toHaveCount(0);
    const mainText = await page.locator('main').innerText();
    expect(mainText).not.toMatch(/@/);
    await page.screenshot({
      path: 'test-results/analytics-hardening/contractor-mobile.png',
      fullPage: true,
    });
  });

  test('empty pattern filter and overview retry', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await page.goto('/analytics?dateFrom=2099-01-01&tab=patterns');
    await expect(page.getByText('Сигналов нет')).toBeVisible();
    await page.route('**/api/analytics/overview**', (route) => route.abort());
    await page.getByRole('tab', { name: 'Обзор' }).click();
    await expect(page.getByText('Обзор не загрузился.')).toBeVisible();
    await page.unroute('**/api/analytics/overview**');
    await page.getByRole('button', { name: 'Повторить' }).click();
    await expect(page.locator('[data-analytics-ready="true"]')).toBeVisible();
  });
});
