import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ADMIN_EMAIL = 'alexey.viktorov@example.sgr.local';

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

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(ADMIN_EMAIL);
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

async function chooseDirectoryOption(page: Page, label: string, optionName: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('[data-slot="command-input"]:visible').fill(optionName);
  await page.getByRole('option', { name: optionName }).click();
}

async function chooseObject(page: Page, objectName: string) {
  await chooseDirectoryOption(page, 'Объект', objectName);
}

async function chooseCustomerAndForm(page: Page) {
  await page.getByRole('combobox', { name: 'Заказчик', exact: true }).click();
  await page.getByRole('option').first().click();
  await page.getByLabel('Форма').click();
  await page.getByRole('option', { name: 'С-1' }).click();
}

async function saveAct(page: Page) {
  await page.getByRole('button', { name: 'Сохранить акт' }).click();
  await expect(page).toHaveURL(/\/acts\/[0-9a-f-]{36}/i);
}

test('empty defect text saves and the registry stays ordered by act date', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = attachConsole(page);
  const stamp = Date.now();
  const objectName = `Реестр ${stamp}`;
  const initialType = `Исходный вид ${stamp}`;
  const typeName = `Вид сорт ${stamp}`;
  const lateLocation = `Поздний ${stamp}`;
  const earlyLocation = `Ранний ${stamp}`;
  const undatedLocation = `Без даты ${stamp}`;

  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);

  await page.goto('/reference-data');
  await page.getByRole('tab', { name: 'Виды дефектов' }).click();
  for (const name of [initialType, typeName]) {
    await page.getByRole('button', { name: 'Создать' }).click();
    await page.getByLabel('Название').fill(name);
    await page.getByRole('button', { name: 'Создать' }).last().click();
    await expect(page.getByText(name).first()).toBeVisible();
  }

  await page.goto('/objects');
  await page.getByRole('button', { name: 'Добавить объект' }).click();
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('Название объекта').fill(objectName);
  await createDialog.getByLabel('Адрес').fill(`Адрес ${stamp}`);
  await createDialog.getByRole('button', { name: 'Создать' }).click();
  await expect(page.getByText('Объект создан')).toBeVisible();

  await page.goto('/acts/new');
  await chooseObject(page, objectName);
  await chooseCustomerAndForm(page);
  await page.getByLabel('Дата акта').fill('2026-11-02');
  await page.getByLabel('Помещение').fill(lateLocation);
  await page.getByLabel('Описание').fill('Описание позднего акта');
  await chooseDirectoryOption(page, 'Вид дефекта', initialType);
  await page.getByRole('combobox', { name: 'Ответственный инженер' }).click();
  await page.getByRole('option', { name: /Орлов Дмитрий/ }).click();
  await saveAct(page);

  await page.goto('/acts/new');
  await chooseObject(page, objectName);
  await chooseCustomerAndForm(page);
  await page.getByLabel('Дата акта').fill('2024-06-01');
  await saveAct(page);

  await page.goto('/acts/new');
  await chooseObject(page, objectName);
  await chooseCustomerAndForm(page);
  await page.getByLabel('Дата акта').fill('2020-03-01');
  await page.getByLabel('Помещение').fill(earlyLocation);
  await page.getByLabel('Описание').fill('Описание раннего акта');
  await chooseDirectoryOption(page, 'Вид дефекта', initialType);
  await saveAct(page);

  await page.goto('/acts/new');
  await chooseObject(page, objectName);
  await chooseCustomerAndForm(page);
  await page.getByLabel('Помещение').fill(undatedLocation);
  await page.getByLabel('Описание').fill('Акт без даты');
  await chooseDirectoryOption(page, 'Вид дефекта', initialType);
  await saveAct(page);

  const registryUrl = `/registry?search=${encodeURIComponent(objectName)}&pageSize=25`;
  await page.goto(registryUrl);
  await expect(page.getByText('Дата акта: сначала новые').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Дата акта: сначала новые' })).toBeVisible();
  const rows = page.locator('.registry-table tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('02.11.2026');
  await expect(rows.nth(0)).toContainText(lateLocation);
  await expect(rows.nth(1)).toContainText('01.06.2024');
  await expect(rows.nth(2)).toContainText('01.03.2020');
  await expect(rows.nth(2)).toContainText(earlyLocation);
  await expect(rows.nth(3)).toContainText(undatedLocation);
  await expect(rows.nth(3)).toContainText('Без номера');

  await page.goto(`${registryUrl}&page=2`);
  await expect(page).toHaveURL(/page=2/);
  await page.getByRole('button', { name: 'Номер акта' }).click();
  await expect(page).toHaveURL(/sortBy=actNumber/);
  await expect(page).toHaveURL(new RegExp(`search=.*${stamp}`));
  await expect(page).toHaveURL(/pageSize=25/);
  await expect(page).not.toHaveURL(/page=2/);
  await expect(page.getByText('Дата акта: сначала новые')).toHaveCount(0);
  await expect(rows.nth(0)).toContainText('01.03.2020');
  await expect(rows.nth(3)).toContainText(undatedLocation);

  const explicit = `/registry?search=${encodeURIComponent(objectName)}&pageSize=25&sortBy=actNumber&sortDirection=asc`;
  await page.goto(explicit);
  await page.reload();
  await expect(page).toHaveURL(/sortBy=actNumber/);
  await expect(page).toHaveURL(/sortDirection=asc/);
  await expect(page).toHaveURL(/pageSize=25/);
  await expect(rows.nth(0)).toContainText(earlyLocation);

  await page.goto(registryUrl);
  await expect(rows.nth(0)).toContainText(lateLocation);
  await rows.nth(0).click();
  await expect(page).toHaveURL(/\/acts\//);
  await expect(page).toHaveURL(/pageSize=25/);
  await page.getByRole('button', { name: 'Взять в работу' }).click();
  await expect(page.getByText('В работе', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Редактировать дефект' }).click();
  await page.getByLabel('Помещение').fill('');
  await page.getByLabel('Описание').fill('');
  await chooseDirectoryOption(page, 'Вид дефекта', typeName);
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Дефект сохранён')).toBeVisible();
  await expect(page.getByText('Не указано').first()).toBeVisible();
  await expect(page.getByText(typeName).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText(typeName).first()).toBeVisible();
  await expect(page.getByText('Не указано').nth(0)).toBeVisible();
  await expect(page.getByText('Не указано').nth(1)).toBeVisible();
  await page.getByRole('button', { name: 'Редактировать дефект' }).click();
  await expect(page.locator('#edit-defect-location')).toHaveValue('');
  await expect(page.locator('#edit-defect-claim')).toHaveValue('');
  await expect(page.locator('#edit-defect-location')).not.toHaveValue('Не указано');
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Назад к реестру' }).click();
  await expect(page).toHaveURL(/pageSize=25/);
  await expect(page).toHaveURL(new RegExp(`search=.*${stamp}`));
  await expect(page).not.toHaveURL(/sortBy=/);
  await expect(page.getByText('Дата акта: сначала новые').first()).toBeVisible();
  await expect(rows.nth(0)).toContainText('02.11.2026');
  await expect(rows.nth(0)).not.toContainText(lateLocation);
  await expect(rows.nth(1)).toContainText('01.06.2024');
  await expect(rows.nth(2)).toContainText(earlyLocation);
  await expect(rows.nth(3)).toContainText(undatedLocation);
  await page.reload();
  await expect(rows.nth(0)).toContainText('02.11.2026');
  await expect(rows.nth(2)).toContainText('01.03.2020');

  await page.setViewportSize({ width: 360, height: 800 });
  const cards = page.locator('.registry-cards li');
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toContainText('02.11.2026');
  await expect(cards.nth(1)).toContainText('01.06.2024');
  await expect(cards.nth(2)).toContainText('01.03.2020');
  await expect(cards.nth(3)).toContainText('Дата акта не указана');
  await expect(page.locator('.registry-table')).toHaveCount(0);
  await noOverflow(page);

  expect(
    errors.filter(
      (message) =>
        !message.includes('favicon') &&
        !(/Failed to load resource/i.test(message) && /\b(400|403|404)\b/.test(message)),
    ),
  ).toEqual([]);
});
