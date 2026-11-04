import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ADMIN_EMAIL = 'alexey.viktorov@example.sgr.local';
const ENGINEER_EMAIL = 'elena.krylova@example.sgr.local';

const VIEWPORTS = [
  { width: 1440, height: 900, zoom: 1 },
  { width: 1024, height: 768, zoom: 1 },
  { width: 768, height: 1024, zoom: 1 },
  { width: 700, height: 900, zoom: 1 },
  { width: 360, height: 800, zoom: 1 },
  { width: 1440, height: 900, zoom: 1.5 },
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

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/registry/);
}

async function logout(page: Page) {
  await page.getByRole('button', { name: 'Меню пользователя' }).click();
  await page.getByRole('menuitem', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/login/);
}

async function noOverflow(page: Page, zoom = 1) {
  const overflow = await page.evaluate((scale) => {
    const width = document.documentElement.scrollWidth;
    const visible = document.documentElement.clientWidth * scale;
    return width > visible + 1;
  }, zoom);
  expect(overflow).toBe(false);
}

test('unassigned engineer requests closure and an administrator confirms it', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = attachConsole(page);
  const stamp = Date.now();
  const objectName = `Согласование ${stamp}`;
  const location = `Подъезд ${stamp}`;
  const reason = `Нет закрепления ${stamp}`;

  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, ADMIN_EMAIL);
  await page.goto('/objects');
  await page.getByRole('button', { name: 'Добавить объект' }).click();
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('Название объекта').fill(objectName);
  await createDialog.getByRole('combobox', { name: 'Ответственные инженеры' }).click();
  await page.getByRole('option', { name: /Крылова/ }).click();
  await page.keyboard.press('Escape');
  await createDialog.getByRole('button', { name: 'Создать' }).click();
  await expect(page.getByText('Объект создан')).toBeVisible();

  await logout(page);
  await login(page, ENGINEER_EMAIL);
  await page.goto('/acts/new');
  await page.getByRole('combobox', { name: 'Объект', exact: true }).click();
  await page.getByRole('option', { name: objectName }).click();
  await page.getByRole('combobox', { name: 'Заказчик', exact: true }).click();
  await page.getByRole('option').first().click();
  await page.getByLabel('Помещение').fill(location);
  await page.getByLabel('Описание').fill('Дефект для согласования закрытия');
  await page.getByRole('combobox', { name: 'Вид дефекта', exact: true }).click();
  await page.getByRole('option').first().click();
  await page.getByLabel('Форма').click();
  await page.getByRole('option', { name: 'С-1' }).click();
  await page.getByLabel('Дата акта').fill('2026-11-04');
  await page.getByRole('combobox', { name: 'Ответственный инженер' }).click();
  await page.getByRole('option', { name: /Крылова/ }).click();
  await page.getByRole('combobox', { name: 'Виновные организации' }).click();
  await page.getByRole('option').first().click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Сохранить акт' }).click();
  await expect(page).toHaveURL(/\/acts\//);
  await page.getByRole('button', { name: 'Взять в работу' }).click();
  await expect(page.getByText('В работе', { exact: true }).first()).toBeVisible();
  const actUrl = page.url();

  await logout(page);
  await login(page, ADMIN_EMAIL);
  await page.goto('/objects');
  await page.getByLabel('Поиск по объектам').fill(objectName);
  const objectRow = page.getByRole('table').getByRole('row', { name: objectName });
  await expect(objectRow).toBeVisible();
  await objectRow.getByRole('button', { name: 'Редактировать' }).click();
  const editDialog = page.getByRole('dialog');
  await editDialog.getByRole('combobox', { name: 'Ответственные инженеры' }).click();
  await page.getByRole('option', { name: /Крылова/ }).click();
  await page.keyboard.press('Escape');
  await editDialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(editDialog).toHaveCount(0);

  await logout(page);
  await login(page, ENGINEER_EMAIL);
  await page.goto(actUrl);
  await expect(page.getByRole('button', { name: 'Запросить закрытие без проверки' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Закрыть акт без проверки' })).toHaveCount(0);
  await expect(page.getByText('В работе', { exact: true }).first()).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom);
    }, viewport.zoom);
    await page.getByRole('button', { name: 'Запросить закрытие без проверки' }).click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'Запросить закрытие без проверки' }),
    ).toBeVisible();
    await expect(dialog).toContainText(objectName);
    await expect(dialog.getByText('не подтверждает устранение дефектов')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Отправить запрос' })).toBeDisabled();
    await noOverflow(page, viewport.zoom);
    await dialog.getByRole('button', { name: 'Отмена' }).click();
    await expect(dialog).toHaveCount(0);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
  });
  await page.getByRole('button', { name: 'Запросить закрытие без проверки' }).click();
  const requestDialog = page.getByRole('dialog');
  await requestDialog.getByLabel('Причина').fill(reason);
  await requestDialog.getByRole('button', { name: 'Отправить запрос' }).click();
  await expect(page.getByText('Запрос на закрытие без проверки отправлен')).toBeVisible();
  await expect(page.getByText('Ожидает согласования закрытия без проверки')).toBeVisible();
  await expect(page.getByText(reason)).toBeVisible();
  await expect(page.getByText('В работе', { exact: true }).first()).toBeVisible();

  await page.goto('/notifications');
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(/без проверки/).first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });

  await logout(page);
  await login(page, ADMIN_EMAIL);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/notifications');
  await expect(page.getByText(new RegExp(objectName)).first()).toBeVisible();
  await page.goto(actUrl);
  await expect(
    page.getByRole('button', { name: 'Подтвердить закрытие без проверки' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Подтвердить закрытие без проверки' }).click();
  const decision = page.getByRole('dialog');
  await expect(decision.getByText(location)).toBeVisible();
  await noOverflow(page);
  await decision.getByRole('button', { name: 'Подтвердить закрытие без проверки' }).click();
  await expect(page.getByText('Закрытие подтвердил:')).toBeVisible();
  await expect(page.getByText('Инициатор:')).toBeVisible();
  await expect(page.getByText(reason)).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByText('Закрыт без проверки').first()).toBeVisible();
  await noOverflow(page);

  expect(
    errors.filter(
      (message) =>
        !message.includes('favicon') &&
        !(/Failed to load resource/i.test(message) && /\b(400|401|403|404)\b/.test(message)),
    ),
  ).toEqual([]);
});
