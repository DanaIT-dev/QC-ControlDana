import { expect, test, type ConsoleMessage, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ADMIN = 'alexey.viktorov@example.sgr.local';
const ARTIFACTS = resolve(process.cwd(), 'test-results/visual');

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

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(ADMIN);
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

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  expect(value).toBeTruthy();
  return value!;
}

function fieldLabel(control: Locator) {
  return control.locator('xpath=ancestor::div[contains(@class,"gap-1.5")]/span');
}

test.describe('registry filter toolbar alignment', () => {
  test.beforeAll(() => {
    mkdirSync(ARTIFACTS, { recursive: true });
  });

  for (const viewport of [
    { name: '1440', width: 1440, height: 900, desktop: true, screenshot: true },
    { name: '1280', width: 1280, height: 800, desktop: true, screenshot: true },
    { name: '1024', width: 1024, height: 768, desktop: false, screenshot: false },
    { name: '768', width: 768, height: 1024, desktop: false, screenshot: false },
    { name: '390', width: 390, height: 844, desktop: false, screenshot: false, mobile: true },
    { name: '360', width: 360, height: 800, desktop: false, screenshot: false, mobile: true },
  ] as const) {
    test(`toolbar at ${viewport.name}`, async ({ page }) => {
      test.setTimeout(60_000);
      const errors = attachConsole(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await login(page);
      await expect(page.getByLabel('Поиск')).toBeVisible();
      await expect(page.getByRole('button', { name: /Фильтры/ })).toBeVisible();
      await expect(page.getByText(/Найдено:/)).toBeVisible();
      await noOverflow(page);

      if ('mobile' in viewport && viewport.mobile) {
        await page.getByRole('button', { name: /Фильтры/ }).click();
        await expect(page.getByRole('heading', { name: 'Фильтры' })).toBeVisible();
        await page.getByRole('combobox', { name: 'Статус' }).click();
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Показать результаты' }).click();
        await expect(page.getByRole('heading', { name: 'Фильтры' })).toBeHidden();
        await noOverflow(page);
        expect(errors.filter((message) => /hydrat/i.test(message))).toEqual([]);
        expect(applicationErrors(errors)).toEqual([]);
        return;
      }

      const search = page.getByLabel('Поиск');
      const status = page.getByRole('combobox', { name: 'Статус' }).first();
      const object = page.getByRole('combobox', { name: 'Объект' }).first();
      const deadline = page.getByRole('combobox', { name: 'Состояние срока' }).first();
      const filters = page.getByRole('button', { name: /Фильтры/ });
      const found = page.getByText(/Найдено:/);

      await expect(status).toBeVisible();
      await expect(fieldLabel(status)).toHaveText('Статус');
      await expect(fieldLabel(object)).toHaveText('Объект');
      await expect(fieldLabel(deadline)).toHaveText('Состояние срока');

      if (viewport.desktop) {
        const boxes = {
          search: await box(search),
          status: await box(status),
          object: await box(object),
          deadline: await box(deadline),
          filters: await box(filters),
          found: await box(found),
        };
        const controls = [boxes.search, boxes.status, boxes.object, boxes.deadline, boxes.filters];
        for (const control of controls) {
          expect(Math.abs(control.height - 44)).toBeLessThanOrEqual(1);
        }
        const bottoms = controls.map((control) => control.y + control.height);
        expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(1);
        const searchCenter = boxes.search.y + boxes.search.height / 2;
        const foundCenter = boxes.found.y + boxes.found.height / 2;
        expect(Math.abs(foundCenter - searchCenter)).toBeLessThanOrEqual(1);
      }

      if ('screenshot' in viewport && viewport.screenshot) {
        await page.locator('[data-slot="registry-toolbar"]').screenshot({
          path: resolve(ARTIFACTS, `registry-toolbar-${viewport.name}.png`),
        });
      }

      expect(errors.filter((message) => /hydrat/i.test(message))).toEqual([]);
      expect(applicationErrors(errors)).toEqual([]);
    });
  }

  test('desktop filter apply, URL, back/forward and reset', async ({ page }) => {
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    const status = page.getByRole('combobox', { name: 'Статус' }).first();
    await status.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('option', { name: 'В работе' }).click();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/statuses=IN_PROGRESS/);
    await page.goBack();
    await expect(page).not.toHaveURL(/statuses=IN_PROGRESS/);
    await page.goForward();
    await expect(page).toHaveURL(/statuses=IN_PROGRESS/);
    await page.getByRole('button', { name: 'Сбросить' }).click();
    await expect(page).not.toHaveURL(/statuses=IN_PROGRESS/);
    expect(errors.filter((message) => /hydrat/i.test(message))).toEqual([]);
    expect(applicationErrors(errors)).toEqual([]);
  });
});
