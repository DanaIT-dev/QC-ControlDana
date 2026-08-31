import { expect, test, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

const ACCOUNTS = {
  admin: { email: 'alexey.viktorov@example.sgr.local' },
  manager: { email: 'marina.sokolova@example.sgr.local' },
  contractor: { email: 'igor.panteleev@example.sgr.local' },
  responsible: { email: 'dmitry.orlov@example.sgr.local' },
};

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/registry/);
}

async function defectsPayload(page: Page): Promise<Record<string, unknown>> {
  const response = await page.waitForResponse(
    (item) => item.url().includes('/api/registry/defects') && item.request().method() === 'GET',
  );
  return (await response.json()) as Record<string, unknown>;
}

test.describe('role-aware registry', () => {
  test('ADMIN sees summary, proposal A sum, B/C toggle and system status', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const payloadPromise = defectsPayload(page);
    await login(page, ACCOUNTS.admin.email);
    await expect(page.getByText('Сумма предложений А')).toBeVisible();
    const payload = await payloadPromise;
    expect(JSON.stringify(payload)).toMatch(/"slot":"B"/);
    await page.getByRole('button', { name: 'Развернуть предложения B и C' }).click();
    await expect(page.getByRole('button', { name: 'Свернуть предложения B и C' })).toBeVisible();
    await page.getByRole('link', { name: 'Состояние системы' }).click();
    await expect(page).toHaveURL(/\/system-status/);
    expect(errors).toEqual([]);
  });

  test('SGR_MANAGER sees commercial totals and B/C', async ({ page }) => {
    const payloadPromise = defectsPayload(page);
    await login(page, ACCOUNTS.manager.email);
    await expect(page.getByText('Сумма предложений А')).toBeVisible();
    expect(JSON.stringify(await payloadPromise)).toMatch(/"slot":"B"/);
    await expect(page.getByRole('button', { name: 'Развернуть предложения B и C' })).toBeVisible();
  });

  test('CONTRACTOR_ENGINEER sees A/B/C but not proposalASum', async ({ page }) => {
    const payloadPromise = defectsPayload(page);
    await login(page, ACCOUNTS.contractor.email);
    await expect(page.getByText('Сумма предложений А')).toHaveCount(0);
    expect(JSON.stringify(await payloadPromise)).toMatch(/"slot":"B"/);
  });

  test('RESPONSIBLE_ENGINEER sees assigned rows and never receives B/C', async ({
    page,
    request,
  }) => {
    const payloadPromise = defectsPayload(page);
    await login(page, ACCOUNTS.responsible.email);
    const payload = await payloadPromise;
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/"slot":"B"/);
    expect(serialized).not.toMatch(/proposalsBC/);
    await expect(page.getByRole('button', { name: /предложения B и C/ })).toHaveCount(0);
    await expect(page.getByText('Сумма предложений А')).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('link', { name: 'Создать акт' })).toBeVisible();
    await expect(page.getByText('Корпус Б, квартира 7')).toHaveCount(0);
    await expect(page.getByText('Аннулированная строка')).toHaveCount(0);

    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const foreign = await request.get(
      `http://localhost:3001/api/acts/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02`,
      { headers: { cookie: cookieHeader } },
    );
    expect(foreign.status()).toBe(404);
    expect(await foreign.text()).not.toContain('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02');
  });

  test('search, filters, sort, pagination, act detail and URL persistence', async ({ page }) => {
    await login(page, ACCOUNTS.admin.email);
    await page.getByPlaceholder('Номер акта, объект, адрес, заказчик…').fill('Северный');
    await page.getByPlaceholder('Номер акта, объект, адрес, заказчик…').press('Enter');
    await expect(page).toHaveURL(/search=/);
    await page.getByRole('combobox', { name: 'Статус' }).first().click();
    await page.getByRole('option', { name: 'В работе' }).click();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/statuses=/);
    await page.getByRole('button', { name: 'Просрочено' }).click();
    await expect(page).toHaveURL(/deadlineState=/);
    await page.getByRole('button', { name: 'Номер акта' }).click();
    await expect(page).toHaveURL(/sortBy=actNumber/);
    await page.getByLabel('Строк на странице').click();
    await page.getByRole('option', { name: '25' }).click();
    await expect(page).toHaveURL(/pageSize=25/);

    const firstNumber = page.locator('.registry-table tbody tr').first();
    await expect(firstNumber).toBeVisible();
    await firstNumber.click();
    await expect(page).toHaveURL(/\/acts\//);
    await page.getByRole('link', { name: 'Назад к реестру' }).click();
    await expect(page).toHaveURL(/pageSize=25/);
    await page.reload();
    await expect(page).toHaveURL(/pageSize=25/);
  });

  test('empty state, logout, mobile cards and no overflow', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await login(page, ACCOUNTS.admin.email);
    await page.getByPlaceholder('Номер акта, объект, адрес, заказчик…').fill('zzz-no-such-row');
    await page.getByPlaceholder('Номер акта, объект, адрес, заказчик…').press('Enter');
    await expect(page.getByRole('heading', { name: 'Нет строк' })).toBeVisible();
    await page.getByRole('button', { name: 'Сбросить' }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.defect-card').first()).toBeVisible();
    await expect(page.locator('.registry-table')).toHaveCount(0);

    await page.setViewportSize({ width: 360, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);

    await page.getByRole('button', { name: 'Открыть меню' }).click();
    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
  });

  test('ADMIN logout then CONTRACTOR does not keep admin navigation', async ({ page }) => {
    await login(page, ACCOUNTS.admin.email);
    await expect(page.getByRole('link', { name: 'Состояние системы' })).toBeVisible();
    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);
    await login(page, ACCOUNTS.contractor.email);
    await expect(page.getByRole('link', { name: 'Состояние системы' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Создать акт' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Пользователи' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Развернуть предложения B и C' })).toBeVisible();
  });
});
