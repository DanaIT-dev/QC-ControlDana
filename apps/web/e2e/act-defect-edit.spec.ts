import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ADMIN_EMAIL = 'alexey.viktorov@example.sgr.local';

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

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(ADMIN_EMAIL);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/registry/);
}

async function noOverflow(page: Page, zoom = 1) {
  const overflow = await page.evaluate((scale) => {
    const width = document.documentElement.scrollWidth;
    const visible = document.documentElement.clientWidth * scale;
    return width > visible + 1;
  }, zoom);
  expect(overflow).toBe(false);
}

test('engineer corrects a defect after starting the act and finishes it defect by defect', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = attachConsole(page);
  const stamp = Date.now();
  const wrongType = `Неверный вид ${stamp}`;
  const rightType = `Верный вид ${stamp}`;
  const location = `Кухня ${stamp}`;
  const corrected = `Исправленное описание ${stamp}`;

  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto('/reference-data');
  await page.getByRole('tab', { name: 'Виды дефектов' }).click();
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page.getByLabel('Код')).toHaveCount(0);
  await page.getByLabel('Название').fill(wrongType);
  await page.getByRole('button', { name: 'Создать' }).last().click();
  await expect(page.getByText(wrongType).first()).toBeVisible();

  await page.getByRole('button', { name: 'Создать' }).click();
  await page.getByLabel('Название').fill(rightType);
  await page.getByRole('button', { name: 'Создать' }).last().click();
  await expect(page.getByText(rightType).first()).toBeVisible();
  const rightRow = page.getByRole('row', { name: new RegExp(rightType) });
  await rightRow.getByRole('button', { name: 'Редактировать' }).click();
  await page.getByLabel('Название').fill(`${rightType} новое`);
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText(`${rightType} новое`).first()).toBeVisible();

  await page.goto('/acts/new');
  await page.getByRole('combobox', { name: 'Объект', exact: true }).click();
  await page.getByRole('option', { name: /Северный парк/ }).click();
  await page.getByRole('combobox', { name: 'Заказчик', exact: true }).click();
  await page.getByRole('option').first().click();
  await page.getByLabel('Помещение').fill(location);
  await page.getByLabel('Описание').fill('Сначала выбран неверный вид');
  await page.getByRole('combobox', { name: 'Вид дефекта', exact: true }).click();
  await page.getByRole('option', { name: wrongType }).click();
  await page.getByLabel('Форма').click();
  await page.getByRole('option', { name: 'С-1' }).click();
  await page.getByLabel('Дата акта').fill('2026-11-04');
  await page.getByRole('combobox', { name: 'Ответственный инженер' }).click();
  await page.getByRole('option', { name: /Орлов Дмитрий/ }).click();
  await page.getByRole('button', { name: 'Сохранить акт' }).click();
  await expect(page).toHaveURL(/\/acts\//);
  await expect(page.getByText(wrongType).first()).toBeVisible();

  await page.getByRole('button', { name: 'Взять в работу' }).click();
  await expect(page.getByText('В работе', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Завершено дефектов: 0 из 1.')).toBeVisible();
  await expect(
    page.getByText('Акт будет завершён после завершения всех его дефектов.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Завершить акт' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Редактировать дефект' }).click();
  await page.getByLabel('Описание').fill(corrected);
  await page.getByRole('combobox', { name: 'Вид дефекта', exact: true }).click();
  await page.getByRole('option', { name: `${rightType} новое` }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Дефект сохранён')).toBeVisible();
  await page.reload();
  await expect(page.getByText(corrected)).toBeVisible();
  await expect(page.getByText(`${rightType} новое`).first()).toBeVisible();
  await expect(page.getByText('В работе', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Добавить дефект' }).click();
  await page.getByLabel('Помещение').fill(`Ванная ${stamp}`);
  await page.getByLabel('Описание').fill('Вторая позиция');
  await page.getByRole('combobox', { name: 'Вид дефекта', exact: true }).click();
  await page.getByRole('option', { name: wrongType }).click();
  await page.getByRole('combobox', { name: 'Ответственный инженер' }).click();
  await page.getByRole('option', { name: /Орлов Дмитрий/ }).click();
  await page.getByRole('button', { name: 'Добавить' }).click();
  await expect(page.getByText('Завершено дефектов: 0 из 2.')).toBeVisible();

  await page.getByRole('button', { name: 'Завершить дефект' }).first().click();
  await expect(
    page.getByText('Дефект завершён. Акт будет завершён после завершения всех его дефектов.'),
  ).toBeVisible();
  await expect(page.getByText('В работе', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Завершить дефект' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Завершить дефект' }).click();
  await expect(page.getByText('Дефект завершён. Акт завершён.')).toBeVisible();
  await expect(page.getByText('Исполнено', { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText('Завершено дефектов: 2 из 2.')).toBeVisible();
  await expect(page.getByText('Исполнено', { exact: true }).first()).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom);
    }, viewport.zoom);
    await expect(page.getByText(corrected)).toBeVisible();
    await noOverflow(page, viewport.zoom);
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
  });
  expect(
    errors.filter(
      (message) =>
        !message.includes('favicon') &&
        !(/Failed to load resource/i.test(message) && /\b(400|403|404)\b/.test(message)),
    ),
  ).toEqual([]);
});
