import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { e2eApiOrigin, e2eWebOrigin } from './e2e-origins';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ACCOUNTS = {
  admin: 'alexey.viktorov@example.sgr.local',
  manager: 'marina.sokolova@example.sgr.local',
  responsible: 'dmitry.orlov@example.sgr.local',
  contractor: 'igor.panteleev@example.sgr.local',
};

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

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
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

async function chooseFirst(page: Page, label: string) {
  await page.getByRole('combobox', { name: label, exact: true }).first().click();
  await page.getByRole('option').first().click();
}

function objectCombobox(page: Page) {
  return page.getByRole('combobox', { name: 'Объект', exact: true });
}

test.describe('reference access and linked object selection', () => {
  test('RESPONSIBLE_ENGINEER sees read-only object and organization catalogs', async ({ page }) => {
    const errors = attachConsole(page);
    await login(page, ACCOUNTS.responsible);
    await expect(page.getByRole('link', { name: 'Справочники' })).toBeVisible();
    await page.getByRole('link', { name: 'Справочники' }).click();
    await expect(page).toHaveURL(/\/reference-data/);
    await expect(page.getByRole('tab', { name: 'Объекты' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Организации', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Виды работ' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Виды дефектов' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Создать' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Архивировать' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Восстановить' })).toHaveCount(0);
    await page.getByLabel('Поиск справочника').fill('Северный парк');
    await expect(page.getByText('ЖК «Северный парк» (демо)').first()).toBeVisible();
    await expect(page.getByText('г. Минск, ул. Вымышленная, 1').first()).toBeVisible();
    await page.getByRole('tab', { name: 'Организации', exact: true }).click();
    await page.getByLabel('Поиск справочника').fill('Северная инвестиционная');
    await expect(
      page.getByText('ОАО «Северная инвестиционная группа» (демо)').first(),
    ).toBeVisible();

    const me = await page.request.get(`${e2eApiOrigin()}/api/auth/me`);
    expect(me.ok()).toBe(true);
    const csrfToken = ((await me.json()) as { csrfToken: string }).csrfToken;
    const mutation = await page.request.post(
      `${e2eApiOrigin()}/api/reference-data/property-objects`,
      {
        headers: {
          origin: e2eWebOrigin(),
          'x-csrf-token': csrfToken,
        },
        data: { name: 'Попытка записи', address: 'Нет' },
      },
    );
    expect(mutation.status()).toBe(403);
    expect(errors.filter((message) => /hydrat/i.test(message))).toEqual([]);
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('CONTRACTOR_ENGINEER edits only the construction work directory', async ({ page }) => {
    await login(page, ACCOUNTS.contractor);
    await expect(page.getByRole('link', { name: 'Справочники' })).toBeVisible();
    await page.getByRole('link', { name: 'Справочники' }).click();
    await expect(page).toHaveURL(/\/reference-data/);
    await expect(
      page.getByRole('tab', { name: 'Организации по выполнению строительных работ' }),
    ).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Объекты' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Организации', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Создать' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Редактировать' }).first()).toBeVisible();
  });

  test('ADMIN and SGR_MANAGER keep catalog management', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.getByRole('link', { name: 'Справочники' }).click();
    await expect(page.getByRole('button', { name: 'Создать' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Виды работ' })).toBeVisible();
    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await login(page, ACCOUNTS.manager);
    await page.getByRole('link', { name: 'Справочники' }).click();
    await expect(page.getByRole('button', { name: 'Создать' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Виды дефектов' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Пользователи' })).toHaveCount(0);
  });

  test('create act links name and address to one objectId', async ({ page }) => {
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await page.getByRole('main').getByRole('link', { name: 'Создать акт' }).click();
    await expect(page.getByRole('heading', { name: 'Создание акта' })).toBeVisible();

    await objectCombobox(page).click();
    await expect(page.getByRole('option', { name: /Архивный корпус/ })).toHaveCount(0);
    await page.getByRole('option', { name: /Северный парк/ }).click();
    await expect(page.getByRole('combobox', { name: 'Адрес объекта' })).toContainText(
      'ул. Вымышленная, 1',
    );

    await page.getByRole('button', { name: 'Очистить: Объект', exact: true }).click();
    await page.getByRole('combobox', { name: 'Адрес объекта' }).click();
    await page.getByRole('option', { name: /Демонстрационный/ }).click();
    await expect(objectCombobox(page)).toContainText('Речной квартал');
    await expect(page.getByRole('combobox', { name: 'Адрес объекта' })).toContainText(
      'пр. Демонстрационный, 15',
    );

    await objectCombobox(page).click();
    await page.getByRole('option', { name: /Северный парк/ }).click();
    await expect(page.getByRole('combobox', { name: 'Адрес объекта' })).toContainText(
      'ул. Вымышленная, 1',
    );
    await expect(page.getByRole('combobox', { name: 'Адрес объекта' })).not.toContainText(
      'Демонстрационный',
    );

    await chooseFirst(page, 'Заказчик');
    await page.getByLabel('Помещение').fill('Квартира связка');
    await page.getByLabel('Описание').fill('Связанный объект');
    await chooseFirst(page, 'Вид дефекта');
    await page.getByRole('combobox', { name: 'Ответственный инженер' }).click();
    await page.getByRole('option').first().click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Сохранить акт' }).click();
    await expect(page).toHaveURL(/\/acts\//);
    await expect(page.getByText('ЖК «Северный парк» (демо)').first()).toBeVisible();
    await expect(page.getByText('г. Минск, ул. Вымышленная, 1').first()).toBeVisible();
    expect(errors.filter((message) => /hydrat/i.test(message))).toEqual([]);
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('create act linked fields fit 390 and 360 without overflow', async ({ page }) => {
    const errors = attachConsole(page);
    await login(page, ACCOUNTS.admin);
    await page.getByRole('main').getByRole('link', { name: 'Создать акт' }).click();
    for (const viewport of [
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
      { width: 360, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(objectCombobox(page)).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Адрес объекта' })).toBeVisible();
      await objectCombobox(page).click();
      const list = page.getByRole('listbox').or(page.locator('[data-slot="command-list"]'));
      await expect(list.first()).toBeVisible();
      const box = await page.locator('[data-slot="popover-content"]').boundingBox();
      const size = page.viewportSize();
      expect(box).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual((size?.width ?? 0) + 1);
      await page.keyboard.press('Escape');
      await noOverflow(page);
    }
    expect(errors.filter((message) => /hydrat/i.test(message))).toEqual([]);
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('ADMIN assigns object engineers from the catalog MultiSelect', async ({ page }) => {
    const errors = attachConsole(page);
    await login(page, ACCOUNTS.admin);
    await page.getByRole('link', { name: 'Справочники' }).click();
    await expect(page.getByText('Орлов Д.').first()).toBeVisible();
    const stamp = Date.now();
    await page.getByRole('button', { name: 'Создать' }).click();
    await page.getByLabel('Название объекта').fill(`Е2Е объект инженеры ${stamp}`);
    await page.getByLabel('Адрес объекта').fill('Минск, инженеры');
    await page.getByRole('combobox', { name: 'Ответственные инженеры' }).click();
    await page.getByRole('option', { name: /Орлов Дмитрий/ }).click();
    await page.keyboard.press('Escape');
    const created = page.waitForResponse(
      (response) =>
        response.url().includes('/api/reference-data/property-objects') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('dialog').getByRole('button', { name: 'Создать' }).click();
    expect((await created).ok()).toBe(true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByLabel('Поиск справочника').fill(String(stamp));
    await expect(page.getByRole('cell', { name: `Е2Е объект инженеры ${stamp}` })).toBeVisible();
    await expect(page.getByText('Орлов Д.').first()).toBeVisible();
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('RESPONSIBLE_ENGINEER creates an act only on an assigned object', async ({ page }) => {
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.responsible);
    await expect(page.getByRole('main').getByRole('link', { name: 'Создать акт' })).toBeVisible();
    await page.getByRole('main').getByRole('link', { name: 'Создать акт' }).click();
    await expect(page.getByRole('heading', { name: 'Создание акта' })).toBeVisible();
    await objectCombobox(page).click();
    await expect(page.getByRole('option', { name: /Северный парк/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /Речной квартал/ })).toHaveCount(0);
    await page.getByRole('option', { name: /Северный парк/ }).click();
    await chooseFirst(page, 'Заказчик');
    await page.getByLabel('Помещение').fill('Квартира инженера');
    await page.getByLabel('Описание').fill('Создание с объекта');
    await chooseFirst(page, 'Вид дефекта');
    await page.getByRole('combobox', { name: 'Ответственный инженер' }).click();
    await expect(page.getByRole('option', { name: /Орлов Дмитрий/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /Орлов Дмитрий/ })).toContainText(
      'Закреплён за объектом',
    );
    await expect(page.getByRole('option', { name: /Крылова Елена/ })).toBeVisible();
    await page.getByRole('option', { name: /Орлов Дмитрий/ }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Сохранить акт' }).click();
    await expect(page).toHaveURL(/\/acts\//);
    await expect(page.getByText('ЖК «Северный парк» (демо)').first()).toBeVisible();
    await expect(page.getByRole('tab', { name: 'История изменений' })).toBeVisible();
    await expect(page.getByText(/Предложение B|proposalsBC|"slot":"B"/)).toHaveCount(0);

    const me = await page.request.get(`${e2eApiOrigin()}/api/auth/me`);
    expect(me.ok()).toBe(true);
    const csrfToken = ((await me.json()) as { csrfToken: string }).csrfToken;
    const lookupsResponse = await page.request.get(`${e2eApiOrigin()}/api/operations/lookups`);
    expect(lookupsResponse.ok()).toBe(true);
    const lookups = (await lookupsResponse.json()) as {
      customers: Array<{ id: string }>;
      defectTypes: Array<{ id: string }>;
      responsibleEngineers: Array<{ id: string; fullName: string }>;
      propertyObjects: Array<{ id: string; name: string }>;
    };
    expect(lookups.propertyObjects.some((item) => /Северный парк/.test(item.name))).toBe(true);
    expect(lookups.propertyObjects.some((item) => /Речной квартал/.test(item.name))).toBe(false);
    const spoofed = await page.request.post(`${e2eApiOrigin()}/api/acts`, {
      headers: {
        origin: e2eWebOrigin(),
        'x-csrf-token': csrfToken,
        'idempotency-key': `e2e-foreign-${Date.now()}`,
        'content-type': 'application/json',
      },
      data: {
        formCode: 'S1',
        objectId: '22222222-2222-4222-8222-222222222222',
        customerOrganizationId: lookups.customers[0]?.id,
        issuedOn: '2026-08-20',
        defectItems: [
          {
            location: 'Чужой',
            defectTypeId: lookups.defectTypes[0]?.id,
            claimDetails: 'Нет',
            responsibleEngineerIds: lookups.responsibleEngineers
              .filter((item) => item.fullName.includes('Орлов'))
              .map((item) => item.id),
            liableOrganizationIds: [],
          },
        ],
      },
    });
    expect(spoofed.status()).toBe(404);
    expect(await spoofed.text()).not.toContain('22222222-2222-4222-8222-222222222222');
    expect(errors.filter((message) => /hydrat/i.test(message))).toEqual([]);
    expect(applicationErrors(errors)).toEqual([]);
  });
});
