import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { clickPrimaryNavItem } from './nav';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ACCOUNTS = {
  admin: 'alexey.viktorov@example.sgr.local',
  responsible: 'dmitry.orlov@example.sgr.local',
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
      !message.includes('caret-color') &&
      !(/Failed to load resource/i.test(message) && /\b(400|403|404)\b/.test(message)),
  );
}

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

test.describe('directory quick create and engineer select', () => {
  test('ADMIN quick-creates directory values without losing the act form', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await clickPrimaryNavItem(page, 'Создать акт');
    await expect(page.getByRole('heading', { name: 'Создание акта' })).toBeVisible();
    await page.getByLabel('Помещение').fill('Квартира quick-create');
    await page.getByLabel('Описание').fill('Сохраняется после добавления');
    const stamp = Date.now();

    await page.getByRole('combobox', { name: 'Объект', exact: true }).click();
    await expect(page.getByRole('button', { name: '+ Добавить объект' })).toBeVisible();
    await page.getByRole('button', { name: '+ Добавить объект' }).click();
    await page.getByRole('dialog').getByLabel('Название объекта').fill(`Е2Е quick объект ${stamp}`);
    await page.getByRole('dialog').getByLabel('Адрес').fill(`Минск, quick ${stamp}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByText('Объект добавлен')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Объект', exact: true })).toContainText(
      `Е2Е quick объект ${stamp}`,
    );
    await expect(page.getByRole('combobox', { name: 'Адрес объекта' })).toContainText(
      `Минск, quick ${stamp}`,
    );

    await page.getByRole('combobox', { name: 'Заказчик' }).click();
    await page.getByRole('button', { name: '+ Добавить организацию' }).click();
    await page
      .getByRole('dialog')
      .getByLabel('Название организации')
      .fill(`Е2Е quick заказчик ${stamp}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByText(/Организация добавлена/)).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Заказчик' })).toContainText(
      `Е2Е quick заказчик ${stamp}`,
    );

    await page.getByRole('combobox', { name: 'Вид дефекта' }).click();
    await page.getByRole('button', { name: '+ Добавить вид дефекта' }).click();
    await page.getByRole('dialog').getByLabel('Название').fill(`Е2Е quick дефект ${stamp}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByText('Вид дефекта добавлен')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Вид дефекта' })).toContainText(
      `Е2Е quick дефект ${stamp}`,
    );

    await page.getByRole('combobox', { name: 'Вид работ' }).click();
    await page.getByRole('button', { name: '+ Добавить вид работ' }).click();
    await page.getByRole('dialog').getByLabel('Название').fill(`Е2Е quick работы ${stamp}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByText('Вид работ добавлен')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Вид работ' })).toContainText(
      `Е2Е quick работы ${stamp}`,
    );

    await expect(page.getByLabel('Помещение')).toHaveValue('Квартира quick-create');
    await expect(page.getByLabel('Описание')).toHaveValue('Сохраняется после добавления');
    expect(applicationErrors(errors).filter((message) => /hydrat/i.test(message))).toEqual([]);
    expect(applicationErrors(errors)).toEqual([]);
    await noOverflow(page);
  });

  test('engineer dropdown is FIO-only, scrollable and has no add for engineers', async ({
    page,
  }) => {
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, ACCOUNTS.admin);
    await page.goto('/objects');
    await page.getByRole('button', { name: 'Добавить объект' }).click();
    await page.getByRole('combobox', { name: 'Ответственный инженер' }).click();
    const list = page.locator('[data-slot="command-list"]');
    await expect(list).toBeVisible();
    const overflowY = await list.evaluate((node) => getComputedStyle(node).overflowY);
    expect(overflowY).toBe('auto');
    await expect(page.getByRole('option').first()).toBeVisible();
    await expect(page.locator('[data-slot="command-list"]')).not.toContainText('@');
    await expect(page.getByRole('option').first()).not.toContainText('@');
    await list.evaluate((node) => {
      node.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }));
    });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('ФИО ответственного')).toBeVisible();
    await page.getByRole('button', { name: 'Отмена' }).click();

    await clickPrimaryNavItem(page, 'Создать акт');
    await page.getByRole('combobox', { name: 'Объект', exact: true }).click();
    await page.getByRole('option', { name: /Северный парк/ }).click();
    await page.getByRole('combobox', { name: 'Ответственные инженеры' }).click();
    await expect(page.locator('[data-slot="command-list"]')).not.toContainText('@');
    await expect(page.getByRole('option', { name: /Орлов Дмитрий/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Добавить объект' })).toHaveCount(0);
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('SUPER_ADMIN and engineers do not see add commands', async ({ page, browser }) => {
    await login(page, ACCOUNTS.superAdmin);
    await page.goto('/objects');
    await expect(page.getByRole('button', { name: 'Добавить объект' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Редактировать' })).toHaveCount(0);
    await page.goto('/reference-data');
    await expect(page.getByRole('button', { name: 'Создать' })).toHaveCount(0);

    const engineerPage = await browser.newPage();
    await login(engineerPage, ACCOUNTS.responsible);
    await engineerPage.goto('/acts/new');
    await engineerPage.getByRole('combobox', { name: 'Объект', exact: true }).click();
    await expect(engineerPage.getByRole('button', { name: '+ Добавить объект' })).toHaveCount(0);
    await engineerPage.close();
  });

  test('object edit, archive confirmation and viewports', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await page.goto('/objects');
    await page.getByRole('button', { name: 'Добавить объект' }).click();
    const stamp = Date.now();
    const name = `Е2Е edit объект ${stamp}`;
    await page.getByLabel('Название объекта').fill(name);
    await page.getByLabel('Адрес').fill('ул. Редактируемая, 5');
    await page.getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByText('Объект создан')).toBeVisible();
    await page.getByLabel('Поиск по объектам').fill(name);
    await expect(page.getByText(name).filter({ visible: true })).toBeVisible();
    await page.getByRole('button', { name: 'Редактировать' }).click();
    const editDialog = page.getByRole('dialog', { name: 'Редактировать объект' });
    await editDialog.getByLabel('Название объекта').fill(`${name} изменён`);
    await editDialog.getByLabel('Адрес').fill('ул. Редактируемая, 6');
    await editDialog.getByRole('combobox', { name: 'Статус объекта' }).click();
    await page.getByRole('option', { name: 'Архив' }).click();
    await editDialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(page.getByText('Объект сохранён')).toBeVisible();

    await clickPrimaryNavItem(page, 'Создать акт');
    await page.getByRole('combobox', { name: 'Объект', exact: true }).click();
    await expect(page.getByRole('option', { name: new RegExp(name) })).toHaveCount(0);
    await page.keyboard.press('Escape');

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.goto('/acts/new');
      await expect(page.getByRole('heading', { name: 'Создание акта' })).toBeVisible();
      await page.getByRole('combobox', { name: 'Объект', exact: true }).click();
      await expect(page.locator('[data-slot="command-list"]')).toBeVisible();
      await page.keyboard.press('Escape');
      await noOverflow(page);
    }
    expect(applicationErrors(errors).filter((message) => /hydrat/i.test(message))).toEqual([]);
    expect(applicationErrors(errors)).toEqual([]);
  });
});
