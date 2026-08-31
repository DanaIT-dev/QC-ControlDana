import { expect, test, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ORG_A = 'ООО «Альтернатива А» (демо)';
const ORG_B = 'ООО «Альтернатива Б» (демо)';
const ORG_C = 'ООО «Альтернатива В» (демо)';
const DEMO_LOCATION = 'квартира 45';

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

async function defectsPayload(page: Page): Promise<Record<string, unknown>> {
  const response = await page.waitForResponse(
    (item) => item.url().includes('/api/registry/defects') && item.request().method() === 'GET',
  );
  return (await response.json()) as Record<string, unknown>;
}

async function noPageOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

async function openDemoRow(page: Page) {
  await page.getByPlaceholder('Номер акта, объект, адрес, заказчик…').fill(DEMO_LOCATION);
  await page.getByPlaceholder('Номер акта, объект, адрес, заказчик…').press('Enter');
  await expect(page.getByText('Подъезд 2, квартира 45, санузел').first()).toBeVisible();
}

async function restoreDemoProposal(page: Page) {
  await page.getByRole('button', { name: 'Сохранить предложение' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Предложение' });
  await dialog.getByLabel('Сумма').fill('1250.00');
  await dialog.getByRole('combobox', { name: 'Организация' }).click();
  await page.getByRole('option', { name: ORG_A }).click();
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Изменения сохранены')).toBeVisible();
}

test.describe('proposal organization and amount', () => {
  test('ADMIN sees organization and amount for A/B/C without page overflow', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    const payloadPromise = defectsPayload(page);
    await login(page, ACCOUNTS.admin);
    await openDemoRow(page);
    await page.getByRole('button', { name: 'Развернуть предложения B и C' }).click();
    await expect(page.getByText(ORG_A).first()).toBeVisible();
    await expect(page.getByText('1 250,00 BYN').first()).toBeVisible();
    await expect(page.getByText(ORG_B).first()).toBeVisible();
    await expect(page.getByText('1 180,50 BYN').first()).toBeVisible();
    await expect(page.getByText(ORG_C).first()).toBeVisible();
    await expect(page.getByText('1 310,00 BYN').first()).toBeVisible();
    await noPageOverflow(page);
    expect(JSON.stringify(await payloadPromise)).toMatch(/"slot":"B"/);
    await page.getByText('Подъезд 2, квартира 45, санузел').first().click();
    await expect(page.locator('.act-detail')).toBeVisible();
    await expect(page.getByText(ORG_A).first()).toBeVisible();
    await expect(page.getByText('1 250,00 BYN').first()).toBeVisible();
    await expect(page.getByText(ORG_B).first()).toBeVisible();
    expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
  });

  test('SGR_MANAGER sees organization and amount for A/B/C', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.manager);
    await openDemoRow(page);
    await page.getByRole('button', { name: 'Развернуть предложения B и C' }).click();
    await expect(page.getByText(ORG_A).first()).toBeVisible();
    await expect(page.getByText('1 250,00 BYN').first()).toBeVisible();
    await expect(page.getByText(ORG_B).first()).toBeVisible();
    await expect(page.getByText(ORG_C).first()).toBeVisible();
  });

  test('RESPONSIBLE_ENGINEER sees only proposal A in UI and JSON', async ({ page }) => {
    const payloadPromise = defectsPayload(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.responsible);
    await openDemoRow(page);
    const payload = await payloadPromise;
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/"slot":"B"/);
    expect(serialized).not.toMatch(/proposalsBC/);
    await expect(page.getByText(ORG_A).first()).toBeVisible();
    await expect(page.getByText('1 250,00 BYN').first()).toBeVisible();
    await expect(page.getByText('Предложение B')).toHaveCount(0);
    await expect(page.getByText('Предложение C')).toHaveCount(0);
    await expect(page.getByText(ORG_B)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /предложения B и C/ })).toHaveCount(0);
    await page.getByText('Подъезд 2, квартира 45, санузел').first().click();
    await expect(page.locator('.act-detail')).toBeVisible();
    await expect(page.getByText(ORG_A).first()).toBeVisible();
    await expect(page.getByText('Предложение B')).toHaveCount(0);
  });

  test('CONTRACTOR_ENGINEER selects organization from dropdown and persists after reload', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.contractor);
    await expect(page.getByText('Сумма предложений А')).toHaveCount(0);
    await openDemoRow(page);
    await page.getByText('Подъезд 2, квартира 45, санузел').first().click();
    await expect(page).toHaveURL(/\/acts\//);
    try {
      await page.getByRole('button', { name: 'Сохранить предложение' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Предложение' });
      await expect(dialog.locator('select:not([aria-hidden="true"])')).toHaveCount(0);
      await dialog.getByLabel('Сумма').fill('4321.00');
      await dialog.getByRole('combobox', { name: 'Организация' }).click();
      await expect(page.getByRole('option', { name: ORG_A })).toBeVisible();
      await expect(page.getByRole('option', { name: ORG_B })).toBeVisible();
      await page.getByRole('option', { name: ORG_B }).click();
      await dialog.getByRole('button', { name: 'Сохранить' }).click();
      await expect(page.getByText('Изменения сохранены')).toBeVisible();
      await page.reload();
      await expect(page.getByText(ORG_B).first()).toBeVisible();
      await expect(page.getByText('4 321,00 BYN').first()).toBeVisible();
    } finally {
      await restoreDemoProposal(page);
    }
  });

  test('mobile cards show readable proposal blocks without overflow', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await login(page, ACCOUNTS.admin);
    await openDemoRow(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.defect-card').first()).toBeVisible();
    await expect(page.getByText('Предложение А').first()).toBeVisible();
    await expect(page.getByText(ORG_A).first()).toBeVisible();
    await expect(page.getByText('1 250,00 BYN').first()).toBeVisible();
    await noPageOverflow(page);

    await page.setViewportSize({ width: 360, height: 800 });
    await expect(page.locator('[data-slot="proposal-blocks"]').first()).toBeVisible();
    await noPageOverflow(page);
    expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
  });
});
