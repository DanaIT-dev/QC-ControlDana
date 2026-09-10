import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ACCOUNTS = {
  admin: 'alexey.viktorov@example.sgr.local',
  manager: 'marina.sokolova@example.sgr.local',
};

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

async function expectButtonInsideViewport(page: Page, name: string) {
  const button = page.getByRole('button', { name });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  const viewport = page.viewportSize();
  expect(box).toBeTruthy();
  expect(viewport).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
}

async function openCreateAct(page: Page) {
  await page.getByRole('main').getByRole('link', { name: 'Создать акт' }).click();
  await expect(page).toHaveURL(/\/acts\/new/);
  await expect(page.getByRole('heading', { name: 'Создание акта' })).toBeVisible();
}

async function createActFromForm(page: Page, location: string) {
  await page.getByRole('combobox', { name: 'Объект', exact: true }).click();
  await page.getByRole('option', { name: /Северный парк/ }).click();
  await chooseFirst(page, 'Заказчик');
  await page.getByLabel('Помещение').fill(location);
  await page.getByLabel('Описание').fill('Приёмочный дефект');
  await chooseFirst(page, 'Вид дефекта');
  await page.getByRole('combobox', { name: 'Ответственные инженеры' }).click();
  const engineer = page.getByRole('option', { name: /Орлов Дмитрий/ });
  await expect(engineer).toBeVisible();
  await engineer.click();
  await page.keyboard.press('Escape');
  await page.getByLabel('Плановый срок').fill('2026-09-01');
  await page.getByRole('button', { name: 'Создать акт' }).click();
  await expect(page).toHaveURL(/\/acts\//);
}

test.describe('UI acceptance defects', () => {
  test('ADMIN /acts/new hydrates on desktop without React #418', async ({ page }) => {
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await openCreateAct(page);
    await expect(page.locator('[data-draft-key="draft-defect-0"]')).toBeVisible();
    expect(errors.filter(isHydrationError)).toEqual([]);
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('SGR_MANAGER /acts/new hydrates without React #418', async ({ page }) => {
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.manager);
    await openCreateAct(page);
    expect(errors.filter(isHydrationError)).toEqual([]);
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('ADMIN /acts/new hydrates at 390px without overflow or #418', async ({ page }) => {
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, ACCOUNTS.admin);
    await openCreateAct(page);
    await expectNoHorizontalOverflow(page);
    expect(errors.filter(isHydrationError)).toEqual([]);
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('registry filter Back/Forward restores URL, summary and table', async ({ page }) => {
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await expect(page).toHaveURL(/\/registry$/);
    await expect(page.locator('.registry-table tbody tr').first()).toBeVisible();

    await page.getByRole('combobox', { name: 'Объект' }).first().click();
    await page.getByRole('option', { name: 'ЖК «Северный парк» (демо)' }).click();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/objectIds=11111111-1111-4111-8111-111111111111/);
    await expect(page.getByText('Объект: ЖК «Северный парк» (демо)')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Всего/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.goBack();
    await expect(page).not.toHaveURL(/about:blank/);
    await expect(page).toHaveURL(/\/registry$/);
    await expect(page.getByText('Объект: ЖК «Северный парк» (демо)')).toHaveCount(0);
    await expect(page.locator('.registry-table tbody tr').first()).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/objectIds=11111111-1111-4111-8111-111111111111/);
    await expect(page.getByText('Объект: ЖК «Северный парк» (демо)')).toBeVisible();
    await expect(page.locator('.registry-table tbody tr').first()).toBeVisible();
    expect(errors.filter(isHydrationError)).toEqual([]);
  });

  test('Filter Sheet footer stays in viewport at 390×844', async ({ page }) => {
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, ACCOUNTS.admin);
    await page.getByRole('button', { name: 'Фильтры' }).click();
    await expect(page.getByRole('heading', { name: 'Фильтры' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Статус' }).click();
    await page.getByRole('option', { name: 'В работе' }).click();
    await page.keyboard.press('Escape');
    await page.locator('[data-slot="filter-sheet-body"]').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expectButtonInsideViewport(page, 'Показать результаты');
    await page.getByRole('button', { name: 'Показать результаты' }).click();
    await expect(page).toHaveURL(/statuses=IN_PROGRESS/);
    await expect(page.getByRole('heading', { name: 'Фильтры' })).toBeHidden();
    await expectNoHorizontalOverflow(page);
    expect(errors.filter(isHydrationError)).toEqual([]);
  });

  test('Filter Sheet footer stays in viewport at 360×800', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await login(page, ACCOUNTS.admin);
    await page.getByRole('button', { name: 'Фильтры' }).click();
    await expect(page.getByRole('heading', { name: 'Фильтры' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Статус' }).click();
    await page.getByRole('option', { name: 'В работе' }).click();
    await page.keyboard.press('Escape');
    await page.locator('[data-slot="filter-sheet-body"]').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expectButtonInsideViewport(page, 'Показать результаты');
    await page.getByRole('button', { name: 'Показать результаты' }).click();
    await expect(page).toHaveURL(/statuses=IN_PROGRESS/);
    await expectNoHorizontalOverflow(page);
  });

  test('act history refreshes after deadline mutation without reload', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await openCreateAct(page);
    await createActFromForm(page, 'Приёмка история');
    await page.getByRole('tab', { name: 'История изменений' }).click();
    await expect(page.getByText('Создан акт')).toBeVisible();
    await expect(page.getByText('Изменён срок')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Дефекты' }).click();
    await page.getByRole('button', { name: 'Изменить сроки' }).click();
    const dialog = page.getByRole('dialog', { name: 'Сроки дефекта' });
    await dialog.locator('input[name="plannedDeadline"]').fill('2026-09-15');
    await dialog.locator('input[name="reason"]').fill('Перенос по заявке заказчика');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Изменения сохранены')).toBeVisible();

    await page.getByRole('tab', { name: 'История изменений' }).click();
    const first = page.locator('.timeline__item').first();
    await expect(first.getByText('Изменён срок')).toBeVisible();
    await expect(first.getByText('Викторов А.')).toBeVisible();
    await expect(first.getByText('Причина: Перенос по заявке заказчика')).toBeVisible();
    await expect(first.getByText(/plannedDeadline: 2026-09-01/)).toBeVisible();
    await expect(first.getByText(/plannedDeadline: 2026-09-15/)).toBeVisible();
    await expect(page.getByText('Изменён срок')).toHaveCount(1);
  });

  test('Proposal dialog uses shadcn Select on desktop and updates history', async ({ page }) => {
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await page.locator('.registry-table tbody tr').first().click();
    await expect(page).toHaveURL(/\/acts\//);
    await page.getByRole('button', { name: 'Сохранить предложение' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Предложение' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('select:not([aria-hidden="true"])')).toHaveCount(0);
    await expect(dialog.locator('[data-slot="select-trigger"]')).toHaveCount(1);
    await expect(dialog.getByRole('combobox', { name: 'Слот' })).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Организация' })).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Слот' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option', { name: 'A' })).toBeVisible();
    await page.keyboard.press('Escape');
    await dialog.getByRole('combobox', { name: 'Организация' }).click();
    await page.getByRole('option', { name: 'ООО «Альтернатива А» (демо)' }).click();
    await expect(dialog.getByRole('combobox', { name: 'Организация' })).toContainText(
      'ООО «Альтернатива А» (демо)',
    );
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Изменения сохранены')).toBeVisible();
    await page.getByRole('tab', { name: 'История изменений' }).click();
    await expect(page.getByText('Обновлено предложение').first()).toBeVisible();
    expect(errors.filter(isHydrationError)).toEqual([]);
  });

  test('Proposal dialog has no native select at 390px and stays in viewport', async ({ page }) => {
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, ACCOUNTS.admin);
    await page.locator('.defect-card').first().getByRole('button', { name: 'Открыть' }).click();
    await expect(page.locator('.act-detail')).toBeVisible();
    await page.getByRole('button', { name: 'Сохранить предложение' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Предложение' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('select:not([aria-hidden="true"])')).toHaveCount(0);
    await expect(dialog.locator('[data-slot="select-trigger"]')).toHaveCount(1);
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
    await dialog.getByRole('combobox', { name: 'Организация' }).click();
    const list = page.getByRole('listbox');
    await expect(list).toBeVisible();
    const listBox = await list.boundingBox();
    expect(listBox).toBeTruthy();
    expect(listBox!.x + listBox!.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
    expect(listBox!.y + listBox!.height).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
    await page.keyboard.press('Escape');
    await expectNoHorizontalOverflow(page);
    expect(errors.filter(isHydrationError)).toEqual([]);
  });
});
