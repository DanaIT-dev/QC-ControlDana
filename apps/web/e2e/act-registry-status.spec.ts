import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ADMIN = 'alexey.viktorov@example.sgr.local';
const VIEWPORTS = [
  { width: 1440, height: 900, zoom: 1 },
  { width: 1024, height: 768, zoom: 1 },
  { width: 768, height: 1024, zoom: 1 },
  { width: 700, height: 900, zoom: 1 },
  { width: 640, height: 900, zoom: 1 },
  { width: 390, height: 844, zoom: 1 },
  { width: 360, height: 800, zoom: 1 },
  { width: 1440, height: 900, zoom: 1.25 },
  { width: 1440, height: 900, zoom: 1.5 },
] as const;

function daysAhead(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function displayDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

function attachConsole(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

function applicationErrors(errors: string[]) {
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

async function noOverflow(page: Page, zoom = 1) {
  const overflow = await page.evaluate((scale) => {
    const root = document.documentElement;
    return root.scrollWidth > root.clientWidth * scale + 2;
  }, zoom);
  expect(overflow).toBe(false);
}

test.describe('unset act status and informational deadline', () => {
  test('empty act is listed as unset and a deadline stays informational until start', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.getByRole('main').getByRole('link', { name: 'Создать акт' }).click();
    await page.getByRole('button', { name: 'Сохранить акт' }).click();
    await expect(page).toHaveURL(/\/acts\/[0-9a-f-]{36}/i);
    await expect(page.getByText('Статус не установлен', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Без номера').first()).toBeVisible();
    await expect(page.getByText('Объект не указан').first()).toBeVisible();
    await expect(page.getByText('Не заполнен').first()).toBeVisible();
    await expect(page.getByText(/\bSLA\b/)).toHaveCount(0);

    await page.getByRole('link', { name: 'Назад к реестру' }).click();
    await expect(
      page.getByRole('region', { name: 'Незаполненные акты' }).getByText('Без номера').first(),
    ).toBeVisible();
    await page.getByRole('button', { name: /^Статус не установлен/ }).click();
    await expect(page).toHaveURL(/statuses=NEW/);
    await expect(page.getByText('Без номера').first()).toBeVisible();
    await page.getByRole('combobox', { name: 'Статус' }).first().click();
    await expect(page.getByRole('option', { name: 'Статус не установлен' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Создан' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.goto('/acts/new');
    await page.getByRole('combobox', { name: 'Объект', exact: true }).click();
    await page.getByRole('option', { name: /Северный парк/ }).click();
    await page.getByRole('combobox', { name: 'Заказчик', exact: true }).click();
    await page.getByRole('option').first().click();
    await page.getByLabel('Помещение').fill(`Срок до старта ${Date.now()}`);
    await page.getByLabel('Описание').fill('Информационный срок');
    await page.getByRole('combobox', { name: 'Вид дефекта', exact: true }).click();
    await page.getByRole('option').first().click();
    await page.getByLabel('Форма').click();
    await page.getByRole('option', { name: 'С-1' }).click();
    await page.getByLabel('Дата акта').fill('2026-10-16');
    const deadlineIso = daysAhead(9);
    const deadline = page.getByLabel('Срок устранения');
    await deadline.fill(deadlineIso);
    await page.getByRole('button', { name: 'Сохранить акт' }).click();
    await expect(page).toHaveURL(/\/acts\/[0-9a-f-]{36}/i);
    await expect(page.getByText(displayDate(deadlineIso)).first()).toBeVisible();
    await expect(page.getByText('Контроль сроков ещё не запущен').first()).toBeVisible();
    await expect(
      page.getByText(/Осталось \d+ дн|Остался 1 день|Срок наступает сегодня/).first(),
    ).toBeVisible();
    const datedUrl = page.url();
    await page.goto('/registry?deadlineState=OVERDUE');
    await expect(page.getByText('Срок до старта', { exact: false })).toHaveCount(0);

    await page.goto(datedUrl);
    const shownDeadline = displayDate(deadlineIso);
    await expect(page.getByText(shownDeadline).first()).toBeVisible();
    await page.getByRole('button', { name: 'Взять в работу' }).click();
    await expect(page.getByText('В работе', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(shownDeadline).first()).toBeVisible();
    await expect(page.getByText('Контроль сроков ещё не запущен')).toHaveCount(0);

    for (const viewport of VIEWPORTS) {
      await page.evaluate(() => {
        document.documentElement.style.zoom = '';
      });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(datedUrl);
      await expect(page.getByText('В работе', { exact: true }).first()).toBeVisible();
      await page.evaluate((zoom) => {
        document.documentElement.style.zoom = String(zoom);
      }, viewport.zoom);
      await noOverflow(page, viewport.zoom);
    }
    expect(applicationErrors(errors)).toEqual([]);
  });
});
