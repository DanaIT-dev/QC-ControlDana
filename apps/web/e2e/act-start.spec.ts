import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const SUPER_ADMIN_EMAIL = 'super.admin@example.sgr.local';
const ACCOUNTS = {
  admin: 'alexey.viktorov@example.sgr.local',
  contractor: 'igor.panteleev@example.sgr.local',
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

async function chooseFirst(page: Page, label: string) {
  await page.getByRole('combobox', { name: label, exact: true }).first().click();
  const option = page.getByRole('option').first();
  await expect(option).toBeVisible();
  await option.click();
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

async function createActFromForm(page: Page, location: string) {
  await page.getByRole('main').getByRole('link', { name: 'Создать акт' }).click();
  await expect(page).toHaveURL(/\/acts\/new/);
  await page.getByRole('combobox', { name: 'Объект', exact: true }).click();
  await page.getByRole('option', { name: /Северный парк/ }).click();
  await chooseFirst(page, 'Заказчик');
  await page.getByLabel('Помещение').fill(location);
  await page.getByLabel('Описание').fill('Дефект для статуса нового акта');
  await chooseFirst(page, 'Вид дефекта');
  await page.getByLabel('Форма').click();
  await page.getByRole('option', { name: 'С-1' }).click();
  await page.getByLabel('Дата акта').fill('2026-10-16');
  await page.getByRole('combobox', { name: 'Ответственный инженер' }).click();
  const engineer = page.getByRole('option', { name: /Орлов Дмитрий/ });
  await expect(engineer).toBeVisible();
  await engineer.click();
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page).toHaveURL(
    /\/acts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
}

test.describe('new act workflow status', () => {
  test('create stays NEW, start moves to IN_PROGRESS, completing defects reaches COMPLETED', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    const location = `Новый акт ${Date.now()}`;
    await createActFromForm(page, location);
    await expect(page.getByText('Новый акт', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Работа по акту ещё не начата')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Взять в работу' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Исполнить' })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    const actUrl = page.url();
    await page.getByRole('link', { name: 'Назад к реестру' }).click();
    await expect(page).toHaveURL(/\/registry/);
    await page.getByRole('button', { name: /^Новый акт/ }).click();
    await expect(page).toHaveURL(/statuses=NEW/);
    await expect(page.getByText(location).first()).toBeVisible();
    await page.getByRole('combobox', { name: 'Статус' }).first().click();
    await expect(page.getByRole('option', { name: 'Новый акт' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.goto(actUrl);
    await expect(page.getByRole('button', { name: 'Взять в работу' })).toBeVisible();
    await page.getByRole('button', { name: 'Взять в работу' }).dblclick();
    await expect(page.getByText('В работе', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Взять в работу' })).toHaveCount(0);
    await expect(page.getByText('Взят в работу')).toBeVisible();
    await expect(page.getByRole('article').getByLabel('Викторов Алексей')).toBeVisible();
    await page.getByRole('tab', { name: 'История изменений' }).click();
    await expect(page.getByText('Акт взят в работу')).toHaveCount(1);
    await expect(page.getByText(/Кто:\s*Викторов\s+А\./)).toBeVisible();
    await expect(page.getByText(/Дата и время:/)).toBeVisible();

    await page.getByRole('tab', { name: 'Дефекты' }).click();
    await page.getByRole('button', { name: 'Исполнить' }).click();
    await expect(page.getByText('Изменения сохранены')).toBeVisible();
    await expect(page.getByText('Исполнено', { exact: true }).first()).toBeVisible();
    expect(applicationErrors(errors)).toEqual([]);
    expect(errors.filter((message) => /hydrat/i.test(message))).toEqual([]);
  });

  test('shows start to SUPER_ADMIN and hides it from CONTRACTOR', async ({ page }) => {
    test.setTimeout(90_000);
    const provision = spawnSync(
      'pnpm',
      ['--filter', '@sgr-registry/database', 'exec', 'tsx', 'scripts/ensure-test-super-admin.ts'],
      {
        cwd: resolve(process.cwd()),
        encoding: 'utf8',
        env: process.env,
      },
    );
    if (provision.status !== 0) {
      throw new Error(provision.stderr || provision.stdout || 'Failed to provision SUPER_ADMIN');
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    const location = `Ограничение старта ${Date.now()}`;
    await createActFromForm(page, location);
    await expect(page.getByRole('button', { name: 'Взять в работу' })).toBeVisible();
    const actUrl = page.url();
    expect(actUrl).toMatch(/\/acts\/[0-9a-f-]{36}/i);

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);
    await login(page, SUPER_ADMIN_EMAIL);
    await page.goto(actUrl);
    await expect(page.getByText('Новый акт', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Взять в работу' })).toBeVisible();

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);
    await login(page, ACCOUNTS.contractor);
    await page.goto(actUrl);
    await expect(page.getByRole('button', { name: 'Взять в работу' })).toHaveCount(0);
  });

  for (const viewport of VIEWPORTS) {
    test(`new act card fits ${viewport.width}x${viewport.height}`, async ({ page }) => {
      test.setTimeout(60_000);
      const errors = attachConsole(page);
      await page.setViewportSize(viewport);
      await login(page, ACCOUNTS.admin);
      const location = `Viewport ${viewport.width} ${Date.now()}`;
      await createActFromForm(page, location);
      await expect(page.getByText('Новый акт', { exact: true }).first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      const start = page.getByRole('button', { name: 'Взять в работу' });
      await expect(start).toBeVisible();
      const box = await start.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(applicationErrors(errors)).toEqual([]);
    });
  }
});

test.describe('act cancellation', () => {
  test('ADMIN cancels a new act and SUPER_ADMIN has no cancel action', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    const location = `Аннулирование ${Date.now()}`;
    await createActFromForm(page, location);
    const actUrl = page.url();
    await page.getByRole('button', { name: 'Аннулировать' }).click();
    await page.getByLabel('Причина').fill('ошибочно создан в проверке');
    await page.getByRole('dialog').getByRole('button', { name: 'Аннулировать' }).click();
    await expect(page.getByText('Аннулирован').first()).toBeVisible();
    await expect(page.getByText('ошибочно создан в проверке')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);
    await login(page, SUPER_ADMIN_EMAIL);
    await page.goto(actUrl);
    await expect(page.getByRole('button', { name: 'Аннулировать' })).toHaveCount(0);
    expect(applicationErrors(errors)).toEqual([]);
  });
});
