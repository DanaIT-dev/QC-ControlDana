import { expect, test, type Locator, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ADMIN = 'alexey.viktorov@example.sgr.local';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(ADMIN);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/registry/);
}

async function assertTriggerIconInset(trigger: Locator, minInsetPx = 12) {
  const triggerBox = await trigger.boundingBox();
  const icon = trigger.locator('svg').last();
  await expect(icon).toBeVisible();
  const iconBox = await icon.boundingBox();
  expect(triggerBox).toBeTruthy();
  expect(iconBox).toBeTruthy();
  const insetRight = triggerBox!.x + triggerBox!.width - (iconBox!.x + iconBox!.width);
  expect(insetRight).toBeGreaterThanOrEqual(minInsetPx);
}

test.describe('select and combobox visual contract', () => {
  test('keeps icon inset and avoids text collision', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    await page.goto('/acts/new');
    const objectCombobox = page.getByRole('combobox', { name: 'Объект', exact: true });
    await expect(objectCombobox).toBeVisible();
    await assertTriggerIconInset(objectCombobox);

    await page.goto('/objects');
    const statusSelect = page.getByRole('combobox', { name: 'Статус объекта' });
    await expect(statusSelect).toBeVisible();
    await assertTriggerIconInset(statusSelect);

    await page.getByRole('button', { name: 'Добавить объект' }).click();
    const nameInput = page.getByLabel('Название объекта');
    await expect(nameInput).toBeVisible();
    const longName =
      'Очень длинное название объекта для проверки обрезки текста и безопасного отступа справа';
    await nameInput.fill(longName);
    const inputBox = await nameInput.boundingBox();
    expect(inputBox?.height ?? 0).toBeGreaterThanOrEqual(40);

    await page.goto('/registry');
    await page.getByRole('button', { name: 'Фильтры' }).click();
    const formCombobox = page.getByRole('combobox', { name: 'Форма' });
    await assertTriggerIconInset(formCombobox);
    await formCombobox.click();
    const list = page.locator('[data-slot="command-list"]');
    await expect(list).toBeVisible();
    await expect(list).toHaveCSS('overflow-y', 'auto');
    await page.keyboard.press('Escape');
  });

  test('controls stay usable across key viewports', async ({ page }) => {
    await login(page);
    const viewports = [
      { width: 1920, height: 1080 },
      { width: 1280, height: 800 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
      { width: 360, height: 800 },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto('/acts/new');
      const combobox = page.getByRole('combobox', { name: 'Объект', exact: true });
      await expect(combobox).toBeVisible();
      await assertTriggerIconInset(combobox);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflow, `overflow at ${viewport.width}x${viewport.height}`).toBe(false);
    }
  });
});
