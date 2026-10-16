import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { clickAdminNavItem, clickPrimaryNavItem } from './nav';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ACCOUNTS = {
  admin: 'alexey.viktorov@example.sgr.local',
  responsible: 'dmitry.orlov@example.sgr.local',
  contractor: 'igor.panteleev@example.sgr.local',
  superAdmin: 'super.admin@example.sgr.local',
};

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 700, height: 900 },
  { width: 640, height: 900 },
  { width: 540, height: 900 },
  { width: 390, height: 844 },
  { width: 375, height: 812 },
  { width: 360, height: 800 },
] as const;

function isExpectedHttpConsoleError(message: string): boolean {
  return (
    /\b(400|403|404)\b/.test(message) &&
    (/Failed to load resource/i.test(message) ||
      /net::ERR/i.test(message) ||
      /status of/i.test(message))
  );
}

function isHydrationError(message: string): boolean {
  return (
    /hydrat/i.test(message) ||
    /Minified React error #418/.test(message) ||
    /did not match/i.test(message)
  );
}

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
      !isExpectedHttpConsoleError(message) &&
      !message.includes('caret-color'),
  );
}

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/registry/);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

test.describe('objects directory', () => {
  test.beforeAll(() => {
    const result = spawnSync(
      'pnpm',
      ['--filter', '@sgr-registry/database', 'exec', 'tsx', 'scripts/ensure-test-super-admin.ts'],
      {
        cwd: resolve(process.cwd()),
        encoding: 'utf8',
        env: process.env,
      },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'Failed to provision test SUPER_ADMIN');
    }
  });
  for (const viewport of VIEWPORTS) {
    test(`renders without overflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      const errors = attachConsole(page);
      await page.setViewportSize(viewport);
      await login(page, ACCOUNTS.admin);
      await clickPrimaryNavItem(page, 'Объекты');
      await expect(page).toHaveURL(/\/objects/);
      await expect(page.getByRole('heading', { name: 'Объекты' })).toBeVisible();
      if (viewport.width < 768) {
        await page.getByLabel('Поиск по объектам').fill('Очень длинное название');
        await expect(
          page.getByRole('heading', { name: /E2E «Очень длинное название/ }),
        ).toBeVisible();
        await expect(page.locator('table')).toBeHidden();
      } else {
        await expect(page.getByRole('columnheader', { name: 'Объект' })).toBeVisible();
        await expect(page.getByRole('columnheader', { name: 'Адрес' })).toBeVisible();
        const addressClass = await page
          .locator('tbody tr td:nth-child(2)')
          .evaluateAll((nodes) => nodes.map((node) => node.className).join(' '));
        expect(addressClass).not.toMatch(/\btruncate\b|\bline-clamp-/);
      }
      await expectNoHorizontalOverflow(page);
      expect(applicationErrors(errors).filter(isHydrationError)).toEqual([]);
      expect(applicationErrors(errors)).toEqual([]);
    });
  }

  test('supports search, pagination, dates and empty values', async ({ page }) => {
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await page.goto('/objects');
    await expect(page.getByRole('heading', { name: 'Объекты' })).toBeVisible();
    await page.getByLabel('Поиск по объектам').fill('Пустые даты');
    await expect(page.getByText('E2E «Пустые даты»').filter({ visible: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '—' }).first()).toBeVisible();
    await page.getByLabel('Поиск по объектам').fill('Очень длинное название');
    await expect(
      page.getByText(/E2E «Очень длинное название/).filter({ visible: true }),
    ).toBeVisible();
    await expect(page.getByText('15.01.2024').filter({ visible: true })).toBeVisible();
    await expect(page.getByText('Василевич М.В.').filter({ visible: true })).toBeVisible();
    await expect(
      page.getByText('Не связан с учетной записью').filter({ visible: true }),
    ).toHaveCount(1);
    await page.getByLabel('Поиск по объектам').fill('');
    await expect(page).not.toHaveURL(/search=/);
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await page.getByRole('button', { name: 'Вперёд' }).click();
    await expect(page).toHaveURL(/page=2/);
    await expectNoHorizontalOverflow(page);
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('SUPER_ADMIN is read-only and RESPONSIBLE_ENGINEER is object-scoped', async ({
    page,
    browser,
  }) => {
    const errors = attachConsole(page);
    await login(page, ACCOUNTS.superAdmin);
    await page.goto('/objects');
    await expect(page.getByRole('heading', { name: 'Объекты' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Добавить объект' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Импорт' })).toHaveCount(0);
    await expect(page.getByText('Режим просмотра')).toHaveCount(0);

    const responsiblePage = await browser.newPage();
    const responsibleErrors = attachConsole(responsiblePage);
    await login(responsiblePage, ACCOUNTS.responsible);
    await responsiblePage.goto('/objects');
    await expect(responsiblePage.getByRole('heading', { name: 'Объекты' })).toBeVisible();
    await expect(
      responsiblePage.getByText('ЖК «Северный парк» (демо)').filter({ visible: true }),
    ).toBeVisible();
    await expect(
      responsiblePage.getByText('E2E связанный инженер').filter({ visible: true }),
    ).toBeVisible();
    await expect(
      responsiblePage.getByText('E2E «Пустые даты»').filter({ visible: true }),
    ).toHaveCount(0);

    const contractorPage = await browser.newPage();
    await login(contractorPage, ACCOUNTS.contractor);
    await expect(contractorPage.getByRole('link', { name: 'Объекты' })).toHaveCount(0);
    await contractorPage.goto('/objects');
    await expect(contractorPage.getByText('Недостаточно прав', { exact: true })).toBeVisible();

    expect(applicationErrors(errors)).toEqual([]);
    expect(applicationErrors(responsibleErrors)).toEqual([]);
    await responsiblePage.close();
    await contractorPage.close();
  });

  test('ADMIN auto-links a unique engineer and scopes the engineer to assigned objects', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await page.goto('/objects');
    await page.getByLabel('Поиск по объектам').fill('уникальная привязка');
    await expect(page.getByText('E2E уникальная привязка').filter({ visible: true })).toBeVisible();
    await expect(page.getByText('Единственный Э.Э.').filter({ visible: true })).toBeVisible();
    await expect(
      page.getByText('Не связан с учетной записью').filter({ visible: true }),
    ).toHaveCount(1);

    await clickAdminNavItem(page, 'Пользователи');
    await page.getByRole('button', { name: 'Добавить пользователя' }).click();
    const stamp = Date.now();
    const email = `e2e.unique.${stamp}@example.sgr.local`;
    await page.getByLabel('Фамилия').fill('Единственный');
    await page.getByLabel('Имя').fill('Эдуард');
    await page.getByLabel('Отчество').fill('Эдуардович');
    await page.getByLabel('Электронная почта').fill(email);
    await page.locator('#new-user-role').click();
    await page.getByRole('option', { name: 'Ответственный инженер' }).click();
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await expect(page.getByText('Временный пароль показывается один раз')).toBeVisible();
    const tempPassword = (await page.locator('.temp-password').innerText()).trim();
    await page.getByRole('button', { name: 'Закрыть' }).click();

    await clickPrimaryNavItem(page, 'Объекты');
    await page.getByLabel('Поиск по объектам').fill('уникальная привязка');
    await expect(page.getByText('Единственный Э.Э.').filter({ visible: true })).toBeVisible();
    await expect(
      page.getByText('Не связан с учетной записью').filter({ visible: true }),
    ).toHaveCount(0);
    await page.getByLabel('Поиск по объектам').fill('Эдуард Эдуардович');
    await expect(page.getByText('E2E уникальная привязка').filter({ visible: true })).toBeVisible();

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await page.getByLabel('Электронная почта').fill(email);
    await page.getByLabel('Пароль', { exact: true }).fill(tempPassword);
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page).toHaveURL(/\/change-password/);
    await expect(page.getByText('Смена временного пароля')).toBeVisible();
    await page.getByLabel('Текущий пароль').fill(tempPassword);
    await page.getByLabel('Новый пароль').fill(DEMO_PASSWORD);
    await page.getByLabel('Текущий пароль').fill(tempPassword);
    await page.getByRole('button', { name: 'Сменить пароль' }).click();
    await expect(page).toHaveURL(/\/complete-profile/);
    await page.getByLabel('Номер телефона').fill('+375291112233');
    await page.getByLabel('Дата рождения').fill('1990-01-15');
    await page.getByRole('button', { name: 'Сохранить карточку' }).click();
    await expect(page).toHaveURL(/\/registry/);
    await page.goto('/objects');
    await expect(page.getByText('E2E уникальная привязка').filter({ visible: true })).toBeVisible();
    await expect(page.getByText('E2E «Пустые даты»').filter({ visible: true })).toHaveCount(0);
    await expect(page.getByText('E2E связанный инженер').filter({ visible: true })).toHaveCount(0);
    expect(applicationErrors(errors).filter(isHydrationError)).toEqual([]);
    expect(applicationErrors(errors)).toEqual([]);
    await expectNoHorizontalOverflow(page);

    const mobile = await browser.newPage();
    const mobileErrors = attachConsole(mobile);
    await mobile.setViewportSize({ width: 390, height: 844 });
    await login(mobile, email);
    await mobile.goto('/objects');
    await expect(
      mobile.getByText('E2E уникальная привязка').filter({ visible: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(mobile);
    expect(applicationErrors(mobileErrors)).toEqual([]);
    await mobile.close();

    const compact = await browser.newPage();
    const compactErrors = attachConsole(compact);
    await compact.setViewportSize({ width: 360, height: 800 });
    await login(compact, email);
    await compact.goto('/objects');
    await expect(
      compact.getByText('E2E уникальная привязка').filter({ visible: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(compact);
    expect(applicationErrors(compactErrors)).toEqual([]);
    await compact.close();
  });

  test('ADMIN and SGR_MANAGER can create an object with a text engineer name', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await page.goto('/objects');
    await page.getByRole('button', { name: 'Добавить объект' }).click();
    const stamp = Date.now();
    const name = `E2E ручной объект ${stamp}`;
    await page.getByLabel('Название объекта').fill(name);
    await page.getByLabel('Адрес').fill('ул. Ручная, 1');
    await page.getByLabel('ФИО ответственного').fill('Василевич М.В.');
    await page.getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByText('Объект создан')).toBeVisible();
    await page.getByLabel('Поиск по объектам').fill(name);
    await expect(page.getByText(name).filter({ visible: true })).toBeVisible();
    await expect(page.getByText('Василевич М.В.').filter({ visible: true })).toBeVisible();
    const desktopName = page
      .locator('[data-slot="person-name"]')
      .filter({ hasText: 'Василевич' })
      .filter({ visible: true })
      .first();
    await expect(desktopName).toBeVisible();
    const desktopDelta = await desktopName.evaluate((el) => {
      const parts = [...el.querySelectorAll(':scope > span')];
      if (parts.length < 2) {
        return 99;
      }
      return Math.abs(
        parts[0]!.getBoundingClientRect().bottom - parts[1]!.getBoundingClientRect().bottom,
      );
    });
    expect(desktopDelta).toBeLessThanOrEqual(1);
    const desktopLine = page
      .locator('p')
      .filter({ has: page.locator('[data-slot="person-name"]', { hasText: 'Василевич' }) })
      .first();
    const labelDelta = await desktopLine.evaluate((el) => {
      const label = el.querySelector('span.shrink-0');
      const name = el.querySelector('[data-slot="person-name"] > span');
      if (!label || !name) {
        return 99;
      }
      return Math.abs(label.getBoundingClientRect().bottom - name.getBoundingClientRect().bottom);
    });
    expect(labelDelta).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileName = page
      .locator('[data-slot="person-name"]')
      .filter({ hasText: 'Василевич' })
      .filter({ visible: true })
      .first();
    await expect(mobileName).toBeVisible();
    const mobileDelta = await mobileName.evaluate((el) => {
      const parts = [...el.querySelectorAll(':scope > span')];
      if (parts.length < 2) {
        return 99;
      }
      return Math.abs(
        parts[0]!.getBoundingClientRect().bottom - parts[1]!.getBoundingClientRect().bottom,
      );
    });
    expect(mobileDelta).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(
      page.getByText('Не связан с учетной записью').filter({ visible: true }),
    ).toHaveCount(1);
    expect(applicationErrors(errors)).toEqual([]);

    const managerPage = await browser.newPage();
    const managerErrors = attachConsole(managerPage);
    await login(managerPage, 'marina.sokolova@example.sgr.local');
    await managerPage.goto('/objects');
    await managerPage.getByRole('button', { name: 'Добавить объект' }).click();
    const managerName = `E2E объект руководителя ${stamp}`;
    await managerPage.getByLabel('Название объекта').fill(managerName);
    await managerPage.getByRole('button', { name: 'Создать' }).click();
    await expect(managerPage.getByText('Объект создан')).toBeVisible();
    expect(applicationErrors(managerErrors)).toEqual([]);
    await managerPage.close();
  });

  test('ambiguous engineer match requires ADMIN confirmation', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, ACCOUNTS.admin);
    await clickAdminNavItem(page, 'Пользователи');
    const stamp = Date.now();
    for (const [index, fullName] of [
      'Двойник Дмитрий Дмитриевич',
      'Двойник Данила Данилович',
    ].entries()) {
      const [lastName, firstName, middleName] = fullName.split(' ');
      await page.getByRole('button', { name: 'Добавить пользователя' }).click();
      await page.getByLabel('Фамилия').fill(lastName!);
      await page.getByLabel('Имя').fill(firstName!);
      await page.getByLabel('Отчество').fill(middleName!);
      await page
        .getByLabel('Электронная почта')
        .fill(`e2e.twin.${stamp}.${index}@example.sgr.local`);
      await page.getByRole('button', { name: 'Создать', exact: true }).click();
      await expect(page.getByText('Временный пароль показывается один раз')).toBeVisible();
      await page.getByRole('button', { name: 'Закрыть' }).click();
    }
    await clickPrimaryNavItem(page, 'Объекты');
    await page.getByLabel('Поиск по объектам').fill('неоднозначная привязка');
    await expect(
      page.getByText('E2E неоднозначная привязка').filter({ visible: true }),
    ).toBeVisible();
    await expect(page.getByText('Двойник Д.Д.').filter({ visible: true })).toBeVisible();
    await expect(
      page.getByText('Требуется подтверждение администратора').filter({ visible: true }),
    ).toBeVisible();
    await page
      .locator('tr, li')
      .filter({ hasText: 'E2E неоднозначная привязка' })
      .getByRole('button', { name: 'Связать' })
      .click();
    await page.getByRole('combobox', { name: 'Учётная запись инженера' }).click();
    await page.getByRole('option', { name: 'Двойник Дмитрий Дмитриевич' }).click();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(
      page
        .locator('tr, li')
        .filter({ hasText: 'E2E неоднозначная привязка' })
        .getByText('Двойник Д.Д.')
        .first(),
    ).toBeVisible();
    await expect(
      page.getByText('Требуется подтверждение администратора').filter({ visible: true }),
    ).toHaveCount(0);
    expect(applicationErrors(errors)).toEqual([]);
  });
});
