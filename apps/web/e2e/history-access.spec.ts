import { expect, test, type Page } from '@playwright/test';
import { e2eApiOrigin } from './e2e-origins';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ACCOUNTS = {
  admin: 'alexey.viktorov@example.sgr.local',
  manager: 'marina.sokolova@example.sgr.local',
  contractor: 'igor.panteleev@example.sgr.local',
  responsible: 'dmitry.orlov@example.sgr.local',
};

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/registry/);
}

async function noPageOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

async function openFirstAct(page: Page) {
  const row = page.locator('.registry-table tbody tr').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/\/acts\//);
  await expect(page.locator('.act-detail')).toBeVisible();
}

test.describe('history access by role', () => {
  test('ADMIN and SGR_MANAGER see the history tab and events', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await openFirstAct(page);
    await expect(page.getByRole('tab', { name: 'История изменений' })).toBeVisible();
    await page.getByRole('tab', { name: 'История изменений' }).click();
    await expect(page.locator('.timeline__item').first()).toBeVisible();

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);

    await login(page, ACCOUNTS.manager);
    await openFirstAct(page);
    await expect(page.getByRole('tab', { name: 'История изменений' })).toBeVisible();
    await page.getByRole('tab', { name: 'История изменений' }).click();
    await expect(page.locator('.timeline__item').first()).toBeVisible();
    expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
  });

  test('RESPONSIBLE_ENGINEER sees assigned history without B/C', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.responsible);
    await page.getByPlaceholder('Номер акта, объект, адрес, заказчик…').fill('квартира 45');
    await page.getByPlaceholder('Номер акта, объект, адрес, заказчик…').press('Enter');
    await expect(page.getByText('Подъезд 2, квартира 45, санузел').first()).toBeVisible();
    await page.getByText('Подъезд 2, квартира 45, санузел').first().click();
    await expect(page.getByRole('tab', { name: 'История изменений' })).toBeVisible();
    await page.getByRole('tab', { name: 'История изменений' }).click();
    await expect(page.locator('.timeline')).toBeVisible();
    await expect(page.getByText(/Предложение B|proposalsBC|"slot":"B"/)).toHaveCount(0);
  });

  test('CONTRACTOR_ENGINEER has no history UI, network or API access', async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    const historyUrls: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (item) => {
      if (item.url().includes('/history') || item.url().includes('/audit-log')) {
        historyUrls.push(item.url());
      }
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.contractor);
    await openFirstAct(page);
    const actUrl = page.url();
    const actId = actUrl.split('/acts/')[1]?.split('?')[0];
    expect(actId).toBeTruthy();
    await expect(page.getByRole('tab', { name: 'История изменений' })).toHaveCount(0);
    await expect(page.getByText('История изменений')).toHaveCount(0);
    await expect(page.locator('.timeline')).toHaveCount(0);
    await expect(page.getByText('Записей нет')).toHaveCount(0);
    expect(historyUrls).toEqual([]);

    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const history = await request.get(`${e2eApiOrigin()}/api/acts/${actId}/history`, {
      headers: { cookie: cookieHeader },
    });
    expect(history.status()).toBe(403);
    const body = await history.text();
    expect(body).not.toMatch(/DEADLINE_UPDATED|actorName|totalCount|"items"/);

    await expect(page.getByRole('button', { name: 'Сохранить предложение' }).first()).toBeVisible();
    await expect(page.getByText('Срок третьей стороны').first()).toBeVisible();
    await expect(page.getByText('Файлы и фотографии').first()).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await noPageOverflow(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await noPageOverflow(page);
    expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
  });

  test('history cache from ADMIN does not survive contractor login', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await openFirstAct(page);
    await page.getByRole('tab', { name: 'История изменений' }).click();
    await expect(page.locator('.timeline__item').first()).toBeVisible();
    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);

    await login(page, ACCOUNTS.contractor);
    await openFirstAct(page);
    await expect(page.getByRole('tab', { name: 'История изменений' })).toHaveCount(0);
    await expect(page.locator('.timeline__item')).toHaveCount(0);
    await page.goBack();
    await page.goForward();
    await expect(page.getByRole('tab', { name: 'История изменений' })).toHaveCount(0);
  });
});
