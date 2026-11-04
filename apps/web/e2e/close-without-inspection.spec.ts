import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ADMIN_EMAIL = 'alexey.viktorov@example.sgr.local';
const ENGINEER_EMAIL = 'dmitry.orlov@example.sgr.local';

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

test('engineer submits a defect and closes the act without inspection', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = attachConsole(page);
  const stamp = Date.now();
  const location = `Кровля ${stamp}`;
  const reason = `Закрыто инженером ${stamp}`;

  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, ADMIN_EMAIL);
  await page.goto('/acts/new');
  await page.getByRole('combobox', { name: 'Объект', exact: true }).click();
  await page.getByRole('option', { name: /Северный парк/ }).click();
  await page.getByRole('combobox', { name: 'Заказчик', exact: true }).click();
  await page.getByRole('option').first().click();
  await page.getByLabel('Помещение').fill(location);
  await page.getByLabel('Описание').fill('Дефект для проверки и закрытия');
  await page.getByRole('combobox', { name: 'Вид дефекта', exact: true }).click();
  await page.getByRole('option').first().click();
  await page.getByLabel('Форма').click();
  await page.getByRole('option', { name: 'С-1' }).click();
  await page.getByLabel('Дата акта').fill('2026-11-04');
  await page.getByRole('combobox', { name: 'Ответственный инженер' }).click();
  await page.getByRole('option', { name: /Орлов Дмитрий/ }).click();
  await page.getByRole('combobox', { name: 'Виновные организации' }).click();
  await page.getByRole('option').first().click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Сохранить акт' }).click();
  await expect(page).toHaveURL(/\/acts\//);
  await page.getByRole('button', { name: 'Взять в работу' }).click();
  await expect(page.getByText('В работе', { exact: true }).first()).toBeVisible();
  const actUrl = page.url();

  await logout(page);
  await login(page, ENGINEER_EMAIL);
  await page.goto(actUrl);
  await expect(page.getByRole('button', { name: 'Передать на проверку' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Закрыть акт без проверки' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Запросить закрытие без проверки' })).toHaveCount(
    0,
  );

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom);
    }, viewport.zoom);
    await page.getByRole('button', { name: 'Закрыть акт без проверки' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Закрыть акт без проверки?' })).toBeVisible();
    await expect(dialog.getByText('не подтверждает фактическое устранение')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Закрыть акт без проверки' })).toBeDisabled();
    await dialog.getByLabel('Причина закрытия без проверки').fill('   ');
    await expect(dialog.getByRole('button', { name: 'Закрыть акт без проверки' })).toBeDisabled();
    await noOverflow(page, viewport.zoom);
    await dialog.getByRole('button', { name: 'Отмена' }).click();
    await expect(dialog).toHaveCount(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
  });
  await expect(page.getByText('В работе', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Передать на проверку' }).click();
  await page.getByLabel('Комментарий о выполненной работе').fill('Работы переданы на проверку');
  await page.getByRole('button', { name: 'Передать' }).click();
  await expect(page.getByText('Дефект передан на проверку')).toBeVisible();
  await expect(page.getByText('На проверке', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Закрыть акт без проверки' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Ожидают проверки: 1/)).toBeVisible();
  await dialog.getByLabel('Причина закрытия без проверки').fill(reason);
  await dialog.getByRole('button', { name: 'Закрыть акт без проверки' }).click();
  await expect(page.getByText('Акт закрыт без проверки', { exact: true })).toBeVisible();
  await expect(page.getByText(/Закрыл:.*Орлов/)).toBeVisible();
  await expect(page.getByText(reason)).toBeVisible();
  await page.reload();
  await expect(page.getByText('Закрыт без проверки', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(reason)).toBeVisible();
  await expect(page.getByText('Без проверки').first()).toBeVisible();

  await page.goto('/registry');
  await page.getByLabel('Поиск').fill(location);
  await expect(page.getByText('Закрыт без проверки').first()).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom);
    }, viewport.zoom);
    await expect(page.getByText('Закрыт без проверки').first()).toBeVisible();
    await noOverflow(page, viewport.zoom);
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
  });
  expect(
    errors.filter(
      (message) =>
        !message.includes('favicon') &&
        !(/Failed to load resource/i.test(message) && /\b(400|401|403|404)\b/.test(message)),
    ),
  ).toEqual([]);
});
