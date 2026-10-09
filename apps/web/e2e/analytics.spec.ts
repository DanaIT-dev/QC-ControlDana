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
    await expect(async () => {
      if (!page.url().includes('dateFrom=2026-01-01')) {
        await page.getByLabel('Дата регистрации с').fill('2026-01-01');
      }
      await expect(page).toHaveURL(/dateFrom=2026-01-01/);
    }).toPass();
    await page.getByLabel('Дата регистрации по').fill('2026-09-30');
    await expect(page).toHaveURL(/dateFrom=2026-01-01/);
    await expect(page).toHaveURL(/dateTo=2026-09-30/);
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
      const median = await page.getByRole('button', { name: /Медиана закрытия/ }).innerText();
      expect(median).not.toMatch(/[-−]\d/);
      const overflowText = await page.locator('main').innerText();
      expect(overflowText).not.toMatch(/\b(undefined|NaN|Infinity)\b/);
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
    const zoomed = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(zoomed).toBe(false);
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

  test('contractor does not open analytics', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.contractor);
    await expectPrimaryNavItem(page, 'Аналитика', false);
    await page.goto('/analytics');
    await expect(page).not.toHaveURL(/\/analytics/);
    await expect(page.getByRole('heading', { name: 'Аналитика' })).toHaveCount(0);
  });

  test('super admin has no mutation actions', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, ACCOUNTS.superAdmin);
    await page.goto('/analytics');
    await expect(page.getByRole('heading', { name: 'Аналитика' })).toBeVisible();
    await page.getByRole('tab', { name: 'Паттерны' }).click();
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    await expect(
      page.getByText('Сигналов нет').or(page.getByText('Статус: Новый')).first(),
    ).toBeVisible();
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
  ] as const) {
    test(`${role} can open analytics`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page, email);
      await expectPrimaryNavItem(page, 'Аналитика', true);
      await page.goto('/analytics');
      await expect(page.getByRole('heading', { name: 'Аналитика' })).toBeVisible();
      await expect(page.locator('[data-analytics-ready="true"]')).toBeVisible();
      await page.screenshot({
        path: `test-results/analytics-hardening/${role}.png`,
        fullPage: true,
      });
    });
  }

  test('responsible engineer does not open analytics', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.responsible);
    await expectPrimaryNavItem(page, 'Аналитика', false);
    await page.goto('/analytics');
    await expect(page).not.toHaveURL(/\/analytics/);
    await expect(page.getByRole('heading', { name: 'Аналитика' })).toHaveCount(0);
  });

  test('admin opens only the defects that formed a low first-time-right signal', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await page.goto('/analytics?dateFrom=2026-01-01');
    await expect(page.locator('[data-analytics-ready="true"]')).toBeVisible();
    const exposure = page.getByRole('button', { name: /Подтверждённая финансовая нагрузка/ });
    await expect(exposure).toHaveAttribute('title', /фактические затраты компании/);
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
    await expect(signal.first()).toBeVisible();
    await expect(signal.first()).toContainText('Выборка: 6.');
    await signal.first().getByRole('button', { name: 'Показать исходные дефекты' }).click();
    await expect(page).toHaveURL(/tab=drilldown/);
    await expect(page).toHaveURL(/insightId=/);
    await expect(
      page.getByRole('heading', { name: 'Принятие с первой попытки ниже базового уровня' }),
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

  test('contractor does not see analytics in the compact menu', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, ACCOUNTS.contractor);
    await expectPrimaryNavItem(page, 'Аналитика', false);
    await page.goto('/analytics');
    await expect(page).not.toHaveURL(/\/analytics/);
    await expect(page.getByRole('heading', { name: 'Аналитика' })).toHaveCount(0);
  });

  test('filters and durations stay consistent', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await page.goto('/analytics');
    await expect(page.locator('[data-analytics-ready="true"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /Новые сигналы/ })).not.toHaveText(
      /Новые сигналы\s*0/,
    );
    const median = await page.getByRole('button', { name: /Медиана закрытия/ }).innerText();
    expect(median).not.toMatch(/[-−]\d/);
    await page.goto('/analytics?dateFrom=2099-01-01&dateTo=2099-01-02');
    await expect(page.locator('[data-analytics-ready="true"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /Новые сигналы/ })).toContainText('0');
    await page.getByRole('tab', { name: 'Паттерны' }).click();
    await expect(page.getByText('Сигналов нет')).toBeVisible();
    await page.goto('/analytics?dateFrom=2026-01-01');
    await expect(page.locator('[data-analytics-ready="true"]')).toBeVisible();
    const kpiText = await page.getByRole('button', { name: /Новые сигналы/ }).innerText();
    const kpi = Number(kpiText.replace(/\D/g, ''));
    expect(kpi).toBeGreaterThan(0);
    await page.getByRole('tab', { name: 'Паттерны' }).click();
    await expect(page.getByText('Статус: Новый')).toHaveCount(kpi);
    await page.reload();
    await expect(page).toHaveURL(/dateFrom=2026-01-01/);
    await expect(page.getByRole('tab', { name: 'Паттерны' })).toHaveAttribute(
      'data-state',
      'active',
    );
    await expect(page.getByText('Статус: Новый')).toHaveCount(kpi);
    await page.getByRole('tab', { name: 'Обзор' }).click();
    await expect(page.locator('[data-analytics-ready="true"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /Новые сигналы/ })).toContainText(String(kpi));
    await page.getByRole('tab', { name: 'Скорость' }).click();
    await expect(page.getByText('Длительности')).toBeVisible();
    const speed = await page.locator('main').innerText();
    expect(speed).not.toMatch(/[-−]\d[\d\s\u00a0]*,?\d*\s*дн/);
    await page.getByRole('tab', { name: 'Качество данных' }).click();
    const invalidTemporal = page.getByRole('button', {
      name: 'Некорректная последовательность событий',
    });
    await expect(invalidTemporal).toBeVisible();
    await invalidTemporal.click();
    await expect(page.getByText('invalid-sequence')).toBeVisible();
    await page.screenshot({
      path: 'test-results/analytics-hardening/temporal-quality.png',
      fullPage: true,
    });
    expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
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
