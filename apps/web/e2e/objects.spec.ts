import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ACCOUNTS = {
  admin: 'alexey.viktorov@example.sgr.local',
  responsible: 'dmitry.orlov@example.sgr.local',
  contractor: 'igor.panteleev@example.sgr.local',
  superAdmin: 'super.admin@example.sgr.local',
};

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 360, height: 800 },
] as const;

function isExpectedHttpConsoleError(message: string): boolean {
  return (
    /\b(400|403|404)\b/.test(message) &&
    (/Failed to load resource/i.test(message) ||
      /net::ERR/i.test(message) ||
      /status of/i.test(message))
  );
}

function isHydrationError(message: string): boolean {
  return (
    /hydrat/i.test(message) ||
    /Minified React error #418/.test(message) ||
    /did not match/i.test(message)
  );
}

function attachConsole(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  return errors;
}

function applicationErrors(errors: string[]): string[] {
  return errors.filter(
    (message) =>
      !message.includes('favicon') &&
      !isExpectedHttpConsoleError(message) &&
      !message.includes('caret-color'),
  );
}

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/registry/);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

test.describe('objects directory', () => {
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
  for (const viewport of VIEWPORTS) {
    test(`renders without overflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      const errors = attachConsole(page);
      await page.setViewportSize(viewport);
      await login(page, ACCOUNTS.admin);
      if (viewport.width < 768) {
        await page.getByRole('button', { name: 'Открыть меню' }).click();
        await page.getByRole('link', { name: 'Объекты' }).click();
      } else {
        await page.getByRole('link', { name: 'Объекты' }).click();
      }
      await expect(page).toHaveURL(/\/objects/);
      await expect(page.getByRole('heading', { name: 'Объекты' })).toBeVisible();
      if (viewport.width <= 390) {
        await expect(
          page.getByRole('heading', { name: /E2E «Очень длинное название/ }),
        ).toBeVisible();
        await expect(page.locator('table')).toBeHidden();
      } else {
        await expect(page.getByRole('columnheader', { name: 'Объект' })).toBeVisible();
        await expect(page.getByRole('columnheader', { name: 'Адрес' })).toBeVisible();
      }
      await expectNoHorizontalOverflow(page);
      expect(applicationErrors(errors).filter(isHydrationError)).toEqual([]);
      expect(applicationErrors(errors)).toEqual([]);
    });
  }

  test('supports search, pagination, dates and empty values', async ({ page }) => {
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await page.goto('/objects');
    await expect(page.getByRole('heading', { name: 'Объекты' })).toBeVisible();
    await page.getByLabel('Поиск по объектам').fill('Пустые даты');
    await expect(page.getByText('E2E «Пустые даты»').filter({ visible: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '—' }).first()).toBeVisible();
    await page.getByLabel('Поиск по объектам').fill('Очень длинное название');
    await expect(
      page.getByText(/E2E «Очень длинное название/).filter({ visible: true }),
    ).toBeVisible();
    await expect(page.getByText('15.01.2024').filter({ visible: true })).toBeVisible();
    await expect(page.getByText('Василевич М.В.').filter({ visible: true })).toBeVisible();
    await expect(
      page.getByText('Не связан с учетной записью').filter({ visible: true }),
    ).toHaveCount(1);
    await page.getByLabel('Поиск по объектам').fill('');
    await expect(page.getByText('ЖК «Северный парк» (демо)').filter({ visible: true })).toBeVisible(
      {
        timeout: 15_000,
      },
    );
    await page.getByRole('button', { name: 'Вперёд' }).click();
    await expect(page).toHaveURL(/page=2/);
    await expectNoHorizontalOverflow(page);
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('SUPER_ADMIN is read-only and RESPONSIBLE_ENGINEER is object-scoped', async ({
    page,
    browser,
  }) => {
    const errors = attachConsole(page);
    await login(page, ACCOUNTS.superAdmin);
    await page.goto('/objects');
    await expect(page.getByRole('heading', { name: 'Объекты' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Создать' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Импорт' })).toHaveCount(0);
    await expect(page.getByText('Режим просмотра')).toBeVisible();

    const responsiblePage = await browser.newPage();
    const responsibleErrors = attachConsole(responsiblePage);
    await login(responsiblePage, ACCOUNTS.responsible);
    await responsiblePage.goto('/objects');
    await expect(responsiblePage.getByRole('heading', { name: 'Объекты' })).toBeVisible();
    await expect(
      responsiblePage.getByText('ЖК «Северный парк» (демо)').filter({ visible: true }),
    ).toBeVisible();
    await expect(
      responsiblePage.getByText('E2E связанный инженер').filter({ visible: true }),
    ).toBeVisible();
    await expect(
      responsiblePage.getByText('E2E «Пустые даты»').filter({ visible: true }),
    ).toHaveCount(0);

    const contractorPage = await browser.newPage();
    await login(contractorPage, ACCOUNTS.contractor);
    await expect(contractorPage.getByRole('link', { name: 'Объекты' })).toHaveCount(0);
    await contractorPage.goto('/objects');
    await expect(contractorPage.getByText('Недостаточно прав', { exact: true })).toBeVisible();

    expect(applicationErrors(errors)).toEqual([]);
    expect(applicationErrors(responsibleErrors)).toEqual([]);
    await responsiblePage.close();
    await contractorPage.close();
  });
});
