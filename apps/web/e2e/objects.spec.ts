import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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

  test('edits object dates and keeps the directory usable while scrolling', async ({ page }) => {
    test.setTimeout(120_000);
    mkdirSync(resolve(process.cwd(), 'test-results/objects-ui'), { recursive: true });
    const errors = attachConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await page.goto('/objects');
    const stamp = Date.now();
    const name = `E2E даты ${stamp}`;
    const address =
      'г. Минск, проспект Независимости, дом 123, корпус 4, ориентир у пересечения с улицей длинного названия для полного адреса';
    await page.getByRole('button', { name: 'Добавить объект' }).click();
    await page.getByLabel('Название объекта').fill(name);
    await page.getByLabel('Адрес').fill(address);
    await page.getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByText('Объект создан')).toBeVisible();
    await page.getByLabel('Поиск по объектам').fill(name);
    const createdRow = page.locator('tbody tr').filter({ hasText: name });
    await expect(createdRow).toHaveCount(1);
    await expect(createdRow.getByText(name)).toBeVisible();

    await createdRow.getByRole('button', { name: 'Редактировать' }).click();
    const editDialog = page.getByRole('dialog', { name: 'Редактировать объект' });
    await editDialog
      .getByRole('textbox', { name: 'Дата приёмки в эксплуатацию', exact: true })
      .fill('15.03.2024');
    await editDialog
      .getByRole('textbox', { name: 'Дата окончания гарантийного срока', exact: true })
      .fill('15.03.2029');
    await page.getByRole('button', { name: 'Календарь: Дата приёмки в эксплуатацию' }).click();
    const calendar = page.locator('[data-calendar-popover]');
    await expect(calendar).toBeVisible();
    const day = calendar.getByRole('button', { name: '15', exact: true });
    await expect(day).toBeVisible();
    const dayBox = await day.boundingBox();
    expect(dayBox).not.toBeNull();
    const covered = await page.evaluate(
      ({ x, y }) => {
        const target = document.elementFromPoint(x, y);
        return target?.closest('[data-calendar-popover]') ? 'calendar' : target?.tagName;
      },
      { x: (dayBox?.x ?? 0) + 8, y: (dayBox?.y ?? 0) + 8 },
    );
    expect(covered).toBe('calendar');
    await day.click();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Объект сохранён')).toBeVisible();
    await page.reload();
    await expect(page.getByText('15.03.2024').filter({ visible: true })).toBeVisible();
    await expect(page.getByText('15.03.2029').filter({ visible: true })).toBeVisible();

    await createdRow.getByRole('button', { name: 'Редактировать' }).click();
    const clearDialog = page.getByRole('dialog', { name: 'Редактировать объект' });
    await clearDialog
      .getByRole('textbox', { name: 'Дата приёмки в эксплуатацию', exact: true })
      .fill('20.04.2024');
    await clearDialog
      .getByRole('textbox', { name: 'Дата окончания гарантийного срока', exact: true })
      .fill('');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Объект сохранён')).toBeVisible();
    await page.reload();
    await expect(page.getByText('20.04.2024').filter({ visible: true })).toBeVisible();
    await expect(page.getByText('15.03.2029')).toHaveCount(0);
    await expect(page.getByText(address).filter({ visible: true })).toBeVisible();

    await page.goto('/objects?pageSize=50');
    await expect(page.locator('tbody tr').nth(15)).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 1400));
    await expect(page.getByRole('button', { name: 'Добавить объект' })).toBeInViewport();
    await expect(page.getByRole('columnheader', { name: 'Объект' })).toBeInViewport();
    const stuck = await page.evaluate(() => {
      const appHeader = document.querySelector('header')?.getBoundingClientRect();
      const toolbar = document
        .querySelector('[data-slot="objects-toolbar"]')
        ?.getBoundingClientRect();
      const column = document.querySelector('thead th')?.getBoundingClientRect();
      const probe = document.elementFromPoint((column?.left ?? 0) + 24, (column?.top ?? 0) + 8);
      return {
        headerBottom: appHeader ? appHeader.bottom : null,
        toolbarTop: toolbar ? toolbar.top : null,
        toolbarBottom: toolbar ? toolbar.bottom : null,
        columnTop: column ? column.top : null,
        probeInHeader: Boolean(probe?.closest('thead')),
      };
    });
    expect(stuck.headerBottom).not.toBeNull();
    expect(stuck.toolbarTop ?? 0).toBeGreaterThanOrEqual((stuck.headerBottom ?? 0) - 1);
    expect(stuck.toolbarTop ?? 99).toBeLessThan((stuck.headerBottom ?? 0) + 3);
    expect(stuck.columnTop ?? 0).toBeGreaterThanOrEqual((stuck.toolbarBottom ?? 0) - 1);
    expect(stuck.columnTop ?? 99).toBeLessThan((stuck.toolbarBottom ?? 0) + 3);
    expect(stuck.probeInHeader).toBe(true);
    await page.screenshot({
      path: resolve(process.cwd(), 'test-results/objects-ui/1440-scrolled.png'),
    });

    await page.getByRole('button', { name: 'Редактировать' }).first().click();
    await expect(page.getByRole('heading', { name: 'Редактировать объект' })).toBeVisible();
    await page.getByRole('button', { name: 'Календарь: Дата приёмки в эксплуатацию' }).click();
    await expect(page.locator('[data-calendar-popover]')).toBeVisible();
    await page.screenshot({
      path: resolve(process.cwd(), 'test-results/objects-ui/1440-calendar.png'),
    });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    const row = page.locator('tbody tr').first();
    const nameCell = row.locator('td').nth(0);
    const addressCellInRow = row.locator('td').nth(1);
    await page.mouse.move(0, 0);
    const resting = await nameCell.evaluate((element) => getComputedStyle(element).backgroundColor);
    await nameCell.hover();
    const hovered = await nameCell.evaluate((element) => getComputedStyle(element).backgroundColor);
    const neighbor = await addressCellInRow.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(hovered).not.toBe(resting);
    expect(neighbor).toBe(resting);
    await page.mouse.move(0, 0);
    await row.getByRole('button', { name: 'Редактировать' }).focus();
    const focused = await row.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(focused).not.toBe('rgba(0, 0, 0, 0)');

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.getByLabel('Поиск по объектам').fill(name);
    const addressCell = page.locator('tbody tr td').nth(1);
    await expect(addressCell).toContainText('проспект Независимости');
    const addressLayout = await addressCell.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        text: element.textContent ?? '',
        overflowWrap: style.overflowWrap,
        textOverflow: style.textOverflow,
        clipped: element.scrollHeight > element.clientHeight + 2,
        width: element.getBoundingClientRect().width,
      };
    });
    expect(addressLayout.text).toContain(address);
    expect(addressLayout.overflowWrap).not.toBe('anywhere');
    expect(addressLayout.textOverflow).not.toBe('ellipsis');
    expect(addressLayout.clipped).toBe(false);
    expect(addressLayout.width).toBeGreaterThan(180);
    const nameLayout = await page
      .locator('tbody tr td')
      .nth(0)
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          overflowWrap: style.overflowWrap,
          width: element.getBoundingClientRect().width,
        };
      });
    expect(nameLayout.overflowWrap).not.toBe('anywhere');
    expect(nameLayout.width).toBeGreaterThan(150);
    const dateLayout = await page
      .locator('tbody tr td')
      .nth(2)
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          whiteSpace: style.whiteSpace,
          fits: element.scrollWidth <= element.clientWidth + 1,
        };
      });
    expect(dateLayout.whiteSpace).toContain('nowrap');
    expect(dateLayout.fits).toBe(true);
    await page.screenshot({
      path: resolve(process.cwd(), 'test-results/objects-ui/1024-columns.png'),
    });

    await page.setViewportSize({ width: 768, height: 1024 });
    const scroller = page.locator('[data-slot="objects-table-scroll"]');
    await scroller.evaluate((element) => {
      element.scrollLeft = 120;
    });
    const aligned = await page.evaluate(() => {
      const header = document.querySelectorAll('thead th')[1]?.getBoundingClientRect();
      const cell = document.querySelector('tbody tr td:nth-child(2)')?.getBoundingClientRect();
      return {
        delta: header && cell ? Math.abs(header.left - cell.left) : 99,
        scrollLeft: document.querySelector('[data-slot="objects-table-scroll"]')?.scrollLeft ?? 0,
      };
    });
    expect(aligned.scrollLeft).toBeGreaterThan(0);
    expect(aligned.delta).toBeLessThan(2);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: resolve(process.cwd(), 'test-results/objects-ui/768-scrolled-x.png'),
    });

    for (const width of [700, 640]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator('table')).toBeHidden();
      await expect(page.getByText(address).filter({ visible: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Редактировать' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: resolve(process.cwd(), `test-results/objects-ui/${width}-cards.png`),
      });
    }

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 360, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => window.scrollTo(0, 700));
      await expect(page.getByRole('button', { name: 'Добавить объект' })).toBeInViewport();
      await expect(page.locator('table')).toBeHidden();
      await expect(page.getByText(address).filter({ visible: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Редактировать' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: resolve(process.cwd(), `test-results/objects-ui/${viewport.width}-cards.png`),
      });
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/objects');
    await page.getByLabel('Поиск по объектам').fill('Северный');
    await expect(page).toHaveURL(/search=/);
    await page.getByLabel('Строк на странице').click();
    await page.getByRole('option', { name: '50', exact: true }).click();
    await expect(page).toHaveURL(/pageSize=50/);
    await page.goto('/objects');
    await expect(page).toHaveURL(/pageSize=50/);
    await page.reload();
    await expect(page.getByLabel('Поиск по объектам')).toHaveValue('');
    await page.getByLabel('Поиск по объектам').fill('Северный');
    await expect(page).toHaveURL(/search=/, { timeout: 5_000 });
    await page.reload();
    await expect(page.getByLabel('Поиск по объектам')).toHaveValue('Северный');
    await expect(page.getByLabel('Строк на странице')).toContainText('50');

    for (const zoom of [1.25, 1.5]) {
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value);
      }, zoom);
      await page.screenshot({
        path: resolve(process.cwd(), `test-results/objects-ui/1024-zoom-${zoom}.png`),
      });
      await expectNoHorizontalOverflow(page);
      await page.evaluate(() => {
        document.documentElement.style.zoom = '1';
      });
    }

    expect(applicationErrors(errors)).toEqual([]);
  });
});
