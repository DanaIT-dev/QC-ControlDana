import { expect, test, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

async function login(page: Page, email: string, password = DEMO_PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/registry/);
}

test.describe('operational workflow', () => {
  test('ADMIN can manage users, reference data and create an act', async ({ page }) => {
    await login(page, 'alexey.viktorov@example.sgr.local');
    await page.getByRole('link', { name: 'Пользователи' }).click();
    await expect(page).toHaveURL(/\/users$/);
    await page.getByRole('button', { name: 'Создать пользователя' }).click();
    const stamp = Date.now();
    await page.getByLabel('ФИО').fill(`Е2Е Пользователь ${stamp}`);
    await page.getByLabel('Электронная почта').fill(`e2e.${stamp}@example.sgr.local`);
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await expect(page.getByText('Временный пароль показывается один раз')).toBeVisible();

    await page.getByRole('link', { name: 'Справочники' }).click();
    await page.getByLabel('Название объекта').fill(`Е2Е объект ${stamp}`);
    await page.getByLabel('Адрес объекта').fill('Минск, тест');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await expect(page.getByText(`Е2Е объект ${stamp}`)).toBeVisible();

    await page.getByRole('link', { name: 'Создать акт' }).click();
    await expect(page.getByLabel('Объект').locator('option').nth(1)).toBeAttached();
    await page.getByLabel('Объект').selectOption({ index: 1 });
    await page.getByLabel('Заказчик').selectOption({ index: 1 });
    await page.getByLabel('Помещение').fill('Квартира 101');
    await page.getByLabel('Описание').fill('Течь стояка');
    await page.getByLabel('Вид дефекта').selectOption({ index: 1 });
    await page.getByLabel('Ответственные инженеры').selectOption({ index: 0 });
    await page.getByRole('button', { name: 'Добавить дефект' }).click();
    await page.getByLabel('Помещение').nth(1).fill('Квартира 102');
    await page.getByLabel('Описание').nth(1).fill('Окна');
    await page.getByLabel('Вид дефекта').nth(1).selectOption({ index: 1 });
    await page.getByLabel('Ответственные инженеры').nth(1).selectOption({ index: 0 });
    await page.getByRole('button', { name: 'Создать акт' }).click();
    await expect(page).toHaveURL(/\/acts\//);
    await expect(page.getByText('История изменений')).toBeVisible();
  });

  test('SGR_MANAGER has no user management', async ({ page }) => {
    await login(page, 'marina.sokolova@example.sgr.local');
    await expect(page.getByRole('link', { name: 'Пользователи' })).toHaveCount(0);
    await page.goto('/users');
    await expect(page.getByText('Недостаточно прав')).toBeVisible();
  });

  test('RESPONSIBLE_ENGINEER payload has no B/C', async ({ page }) => {
    await login(page, 'dmitry.orlov@example.sgr.local');
    const payloads: string[] = [];
    page.on('response', async (response) => {
      if (response.url().includes('/api/registry/defects') && response.ok()) {
        payloads.push(await response.text());
      }
    });
    await page.goto('/registry');
    await expect(page.getByText('Реестр дефектных актов').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect.poll(() => payloads.join(' ')).not.toMatch(/proposalsBC/);
  });

  test('360px create act form does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await login(page, 'alexey.viktorov@example.sgr.local');
    await page.getByRole('link', { name: 'Создать акт' }).click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});
