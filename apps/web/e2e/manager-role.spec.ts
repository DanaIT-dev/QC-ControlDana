import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { clickAdminNavItem } from './nav';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ORG_MANAGER = 'olga.romanova@example.sgr.local';
const ADMIN = 'alexey.viktorov@example.sgr.local';

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
  const pageErrors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error' && !isExpectedHttpConsoleError(message.text())) {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  return {
    errors,
    pageErrors,
    hydration: () => errors.filter(isHydrationError),
  };
}

async function login(page: Page, email: string, password = DEMO_PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/registry/);
}

function primaryNav(page: Page) {
  return page.getByLabel('Основная навигация').filter({ visible: true });
}

async function openUsers(page: Page) {
  await clickAdminNavItem(page, 'Пользователи');
  await expect(page).toHaveURL(/\/users/);
}

async function chooseFirst(page: Page, label: string) {
  await page.getByRole('combobox', { name: label, exact: true }).first().click();
  await page.getByRole('option').first().click();
}

test.describe('MANAGER role and profile editing', () => {
  test('MANAGER sees ADMIN business pages and can create an act and an object', async ({
    page,
  }) => {
    const consoleState = attachConsole(page);
    await login(page, ORG_MANAGER);
    const nav = primaryNav(page);
    await expect(nav.getByRole('link', { name: 'Реестр' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Объекты' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Создать акт' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Контроль сроков' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Справочники' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Администрирование' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Пользователи' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Состояние системы' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Администраторы' })).toHaveCount(0);

    const stamp = Date.now();
    await nav.getByRole('link', { name: 'Объекты' }).click();
    await page.getByRole('button', { name: 'Добавить объект' }).click();
    await page.getByLabel('Название объекта').fill(`Руководитель объект ${stamp}`);
    await page.getByLabel('Адрес').fill('Минск, руководитель');
    await page.getByRole('dialog').getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByText('Объект создан')).toBeVisible();
    await page.getByLabel('Поиск по объектам').fill(`Руководитель объект ${stamp}`);
    await expect(
      page.getByText(`Руководитель объект ${stamp}`).filter({ visible: true }),
    ).toBeVisible();

    await nav.getByRole('link', { name: 'Создать акт' }).click();
    await page.getByRole('combobox', { name: 'Объект', exact: true }).click();
    await page.getByRole('option', { name: /Северный парк/ }).click();
    await chooseFirst(page, 'Заказчик');
    await page.getByLabel('Помещение').fill('Квартира 201');
    await page.getByLabel('Описание').fill('Дефект руководителя');
    await page.getByRole('combobox', { name: 'Вид дефекта' }).first().click();
    await page.getByRole('option').first().click();
    await page.getByRole('combobox', { name: 'Ответственные инженеры' }).click();
    await page.getByRole('option').first().click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Создать акт' }).click();
    await expect(page).toHaveURL(/\/acts\//);
    expect(consoleState.hydration()).toEqual([]);
    expect(consoleState.pageErrors).toEqual([]);
  });

  test('MANAGER can edit a lower user and cannot assign MANAGER or ADMIN', async ({ page }) => {
    await login(page, ORG_MANAGER);
    await openUsers(page);
    await expect(page.getByText('Руководитель СГР').first()).toBeVisible();
    await expect(page.getByText('Руководитель', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Добавить пользователя' }).click();
    const stamp = Date.now();
    await page.getByLabel('ФИО').fill(`Е2Е Инженер ${stamp}`);
    await page.getByLabel('Электронная почта').fill(`e2e.manager.${stamp}@example.sgr.local`);
    await page.getByRole('combobox', { name: 'Роль' }).click();
    await expect(page.getByRole('option', { name: 'Руководитель', exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: 'Администратор' })).toHaveCount(0);
    await page.getByRole('option', { name: 'Ответственный инженер' }).click();
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await expect(page.getByText('Временный пароль показывается один раз')).toBeVisible();
    await page.getByRole('button', { name: 'Закрыть' }).click();

    await page.getByLabel('Поиск пользователей').fill(`e2e.manager.${stamp}@example.sgr.local`);
    const row = page.getByRole('row', { name: new RegExp(`Е2Е Инженер ${stamp}`) });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Действия' }).click();
    await page.getByRole('menuitem', { name: 'Редактировать' }).click();
    await page.getByLabel('Фамилия').fill('Сидоров');
    await page.getByLabel('Имя').fill('Пётр');
    await page.getByLabel('Отчество').fill('Иванович');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('table').getByText('Сидоров Пётр Иванович')).toBeVisible();

    const updatedRow = page.getByRole('row', { name: /Сидоров Пётр Иванович/ });
    await updatedRow.getByRole('button', { name: 'Действия' }).click();
    await page.getByRole('menuitem', { name: 'Изменить роль' }).click();
    await page.getByRole('combobox', { name: 'Новая роль' }).click();
    await expect(page.getByRole('option', { name: 'Руководитель', exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: 'Администратор' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Отмена' }).click();
  });

  test('ADMIN can open profile editing for a lower user', async ({ page }) => {
    await login(page, ADMIN);
    await openUsers(page);
    await page.getByLabel('Поиск пользователей').fill('olga.romanova');
    const row = page.getByRole('row', { name: /Ольга Романова|Романова Ольга/ });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Действия' }).click();
    await page.getByRole('menuitem', { name: 'Редактировать' }).click();
    await expect(page.getByLabel('Фамилия')).toBeVisible();
    await expect(page.getByLabel('Имя')).toBeVisible();
    await expect(page.getByLabel('Электронная почта')).toBeVisible();
    await page.getByRole('button', { name: 'Отменить' }).click();
  });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.width}px users form does not overflow`, async ({ page }) => {
      const consoleState = attachConsole(page);
      await page.setViewportSize(viewport);
      await login(page, ORG_MANAGER);
      await openUsers(page);
      await page.getByRole('button', { name: 'Добавить пользователя' }).click();
      await expect(page.getByLabel('ФИО')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflow).toBe(false);
      expect(consoleState.hydration()).toEqual([]);
      expect(consoleState.pageErrors).toEqual([]);
    });
  }
});
