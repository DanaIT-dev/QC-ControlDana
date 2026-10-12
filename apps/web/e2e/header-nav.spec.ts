import { expect, test, type Page } from '@playwright/test';
import {
  clickAdminNavItem,
  clickPrimaryNavItem,
  expectAdminNavItem,
  expectNoAdminMenu,
  expectPrimaryNavItem,
  openMobileMenu,
} from './nav';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ACCOUNTS = {
  superAdmin: 'super.admin@example.sgr.local',
  admin: 'alexey.viktorov@example.sgr.local',
  manager: 'olga.romanova@example.sgr.local',
  sgrManager: 'marina.sokolova@example.sgr.local',
  responsible: 'dmitry.orlov@example.sgr.local',
  contractor: 'igor.panteleev@example.sgr.local',
} as const;

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 360, height: 800 },
] as const;

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

async function expectAppFooter(page: Page) {
  const footer = page.getByRole('contentinfo');
  await expect(footer).toBeVisible();
  await expect(footer).toHaveText('Inspired by Andrew Rodkevich');
  await expect(footer.getByRole('link')).toHaveCount(0);
  const metrics = await footer.evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      position: style.position,
      height: box.height,
      wraps: el.scrollHeight > el.clientHeight + 2,
    };
  });
  expect(metrics.position).not.toBe('fixed');
  expect(metrics.position).not.toBe('sticky');
  expect(metrics.height).toBeLessThanOrEqual(40);
  expect(metrics.height).toBeGreaterThan(20);
  expect(metrics.wraps).toBe(false);
}

async function expectFooterAtViewportBottom(page: Page) {
  const result = await page.evaluate(() => {
    const footer = document.querySelector('[data-slot="app-footer"]');
    if (!(footer instanceof HTMLElement)) {
      return { found: false, bottom: 0, viewport: 0 };
    }
    const box = footer.getBoundingClientRect();
    return {
      found: true,
      bottom: Math.round(box.bottom),
      viewport: Math.round(window.innerHeight),
    };
  });
  expect(result.found).toBe(true);
  expect(result.bottom).toBeGreaterThanOrEqual(result.viewport - 2);
  expect(result.bottom).toBeLessThanOrEqual(result.viewport + 2);
}

async function expectFooterBelowContent(page: Page) {
  const result = await page.evaluate(() => {
    const footer = document.querySelector('[data-slot="app-footer"]');
    const main = document.querySelector('main');
    if (!(footer instanceof HTMLElement) || !(main instanceof HTMLElement)) {
      return { ok: false, footerTop: 0, mainBottom: 0 };
    }
    const footerTop = footer.getBoundingClientRect().top + window.scrollY;
    const mainBottom = main.getBoundingClientRect().bottom + window.scrollY;
    return { ok: footerTop >= mainBottom - 1, footerTop, mainBottom };
  });
  expect(result.ok).toBe(true);
}

async function headerMetrics(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('[data-slot="app-header"]');
    if (!(header instanceof HTMLElement)) {
      return { height: 0, wraps: [] as string[], overlaps: false };
    }
    const height = header.getBoundingClientRect().height;
    const textNodes = Array.from(
      header.querySelectorAll(
        '[data-slot="app-nav-desktop"] a, [data-slot="app-nav-desktop"] button',
      ),
    ) as HTMLElement[];
    const wraps = textNodes
      .filter((el) => {
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!text) {
          return false;
        }
        const range = document.createRange();
        range.selectNodeContents(el);
        const tops = new Set<number>();
        for (const rect of range.getClientRects()) {
          if (rect.width < 1 || rect.height < 1) {
            continue;
          }
          const top = Math.round(rect.top);
          if (![...tops].some((value) => Math.abs(value - top) <= 2)) {
            tops.add(top);
          }
        }
        return tops.size > 1;
      })
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim());
    const clusters = ['app-logo', 'app-nav-desktop', 'app-header-actions']
      .map((slot) => header.querySelector(`[data-slot="${slot}"]`))
      .filter((el): el is HTMLElement => el instanceof HTMLElement)
      .filter((el) => el.getClientRects().length > 0);
    let overlaps = false;
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const a = clusters[i]!.getBoundingClientRect();
        const b = clusters[j]!.getBoundingClientRect();
        const intersect =
          a.left < b.right - 1 &&
          a.right > b.left + 1 &&
          a.top < b.bottom - 1 &&
          a.bottom > b.top + 1;
        if (intersect) {
          overlaps = true;
        }
      }
    }
    return { height, wraps, overlaps };
  });
}

test.describe('responsive header navigation', () => {
  test('groups administration items by role and keeps routes', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.superAdmin);
    await expect(page.getByText('Режим просмотра')).toHaveCount(0);
    await expectPrimaryNavItem(page, 'Реестр', true);
    await expectPrimaryNavItem(page, 'Объекты', true);
    await expectPrimaryNavItem(page, 'Контроль сроков', true);
    await expectPrimaryNavItem(page, 'Уведомления', true);
    await expectPrimaryNavItem(page, 'Справочники', true);
    await expectPrimaryNavItem(page, 'Создать акт', true);
    await expectAdminNavItem(page, 'Пользователи', true);
    await expectAdminNavItem(page, 'Администраторы', true);
    await expectAdminNavItem(page, 'Журнал аудита', true);
    await expectAdminNavItem(page, 'Состояние системы', true);
    await clickAdminNavItem(page, 'Журнал аудита');
    await expect(page).toHaveURL(/\/history/);
    await expect(page.getByRole('button', { name: 'Администрирование' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await clickAdminNavItem(page, 'Состояние системы');
    await expect(page).toHaveURL(/\/system-status/);
    await expect(page.getByRole('link', { name: 'Создать акт' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Перезапустить' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await login(page, ACCOUNTS.admin);
    await expectAdminNavItem(page, 'Пользователи', true);
    await expectAdminNavItem(page, 'Состояние системы', true);
    await expectAdminNavItem(page, 'Журнал аудита', true);
    await expectAdminNavItem(page, 'Администраторы', false);
    await expectPrimaryNavItem(page, 'Создать акт', true);

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await login(page, ACCOUNTS.manager);
    await expectAdminNavItem(page, 'Пользователи', true);
    await expectAdminNavItem(page, 'Администраторы', false);

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await login(page, ACCOUNTS.sgrManager);
    await expectAdminNavItem(page, 'Журнал аудита', true);
    await expectAdminNavItem(page, 'Пользователи', true);
    await expectAdminNavItem(page, 'Состояние системы', false);

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await login(page, ACCOUNTS.responsible);
    await expectNoAdminMenu(page);
    await expectPrimaryNavItem(page, 'Создать акт', true);

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await login(page, ACCOUNTS.contractor);
    await expectNoAdminMenu(page);
    await expectPrimaryNavItem(page, 'Реестр', true);
    await expectPrimaryNavItem(page, 'Справочники', true);
    await expectAppFooter(page);
    expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
  });

  test('administration dropdown is keyboard accessible', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    const trigger = page.getByRole('button', { name: 'Администрирование' });
    const triggerNode = page
      .locator('[data-slot="dropdown-menu-trigger"]')
      .filter({ hasText: 'Администрирование' });
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await expect(triggerNode).toHaveAttribute('aria-expanded', 'false');
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(triggerNode).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menuitem', { name: 'Пользователи' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Пользователи' })).toHaveCount(0);
    await expect(triggerNode).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(page.getByRole('menuitem', { name: 'Пользователи' })).toBeVisible();
    const menuBox = await page.getByRole('menu').boundingBox();
    expect(menuBox).toBeTruthy();
    const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
    const outsideX =
      menuBox!.x > 80 ? 16 : Math.min(viewport.width - 16, menuBox!.x + menuBox!.width + 32);
    const outsideY = Math.min(viewport.height - 16, menuBox!.y + menuBox!.height + 40);
    await page.mouse.click(outsideX, outsideY);
    await expect(page.getByRole('menuitem', { name: 'Пользователи' })).toHaveCount(0);
    await trigger.press('Enter');
    await page.getByRole('menuitem', { name: 'Пользователи' }).press('Enter');
    await expect(page).toHaveURL(/\/users/);
  });

  for (const viewport of VIEWPORTS) {
    test(`header stays single-line at ${viewport.width}px`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize(viewport);
      await login(page, ACCOUNTS.admin);
      await noOverflow(page);
      if (viewport.width >= 1280) {
        const metrics = await headerMetrics(page);
        expect(metrics.height).toBeLessThanOrEqual(72);
        expect(
          metrics.wraps.filter((text) =>
            /Контроль сроков|Журнал|Состояние|Администрирование/.test(text),
          ),
        ).toEqual([]);
        expect(metrics.overlaps).toBe(false);
        await expect(page.getByRole('button', { name: 'Открыть меню' })).toHaveCount(0);
        await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible();
      } else {
        await expect(page.getByRole('button', { name: 'Открыть меню' })).toBeVisible();
        await expect(page.locator('header').getByRole('navigation')).toHaveCount(0);
        await openMobileMenu(page);
        await expect(
          page.getByRole('dialog').getByText('Администрирование', { exact: true }),
        ).toBeVisible();
        await page
          .getByRole('dialog')
          .getByRole('link', { name: 'Пользователи', exact: true })
          .click();
        await expect(page).toHaveURL(/\/users/);
      }
      await clickPrimaryNavItem(page, 'Реестр');
      await expect(page).toHaveURL(/\/registry/);
      await expectAppFooter(page);
      await noOverflow(page);
      expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
    });
  }
});

test.describe('app shell footer', () => {
  test('appears on internal pages with exact credit and stays out of the way', async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/login');
    await expect(page.getByRole('contentinfo')).toHaveCount(0);
    await login(page, ACCOUNTS.admin);
    const pages = [
      '/registry',
      '/analytics',
      '/objects',
      '/deadlines',
      '/notifications',
      '/reference-data',
      '/users',
      '/history',
      '/system-status',
      '/change-password',
      '/acts/new',
    ];
    for (const href of pages) {
      await page.goto(href);
      await expectAppFooter(page);
      await expectFooterBelowContent(page);
      await noOverflow(page);
    }
    await page.goto('/change-password');
    await expectFooterAtViewportBottom(page);
    await page.goto('/registry');
    await expect(page.locator('.registry-table tbody tr').first()).toBeVisible();
    await expectFooterBelowContent(page);
    const overlap = await page.evaluate(() => {
      const footer = document.querySelector('[data-slot="app-footer"]');
      const table = document.querySelector('.registry-table');
      if (!(footer instanceof HTMLElement) || !(table instanceof HTMLElement)) {
        return true;
      }
      const a = footer.getBoundingClientRect();
      const b = table.getBoundingClientRect();
      return (
        a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1
      );
    });
    expect(overlap).toBe(false);

    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await login(page, ACCOUNTS.superAdmin);
    await page.goto('/super-admin');
    await expectAppFooter(page);
    expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
  });

  for (const viewport of VIEWPORTS) {
    test(`footer stays compact at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await login(page, ACCOUNTS.admin);
      await expectAppFooter(page);
      await expectFooterBelowContent(page);
      await noOverflow(page);
      await page.goto('/change-password');
      await expectAppFooter(page);
      const pageScrolls = await page.evaluate(
        () => document.documentElement.scrollHeight > window.innerHeight + 2,
      );
      if (pageScrolls) {
        await expectFooterBelowContent(page);
      } else {
        await expectFooterAtViewportBottom(page);
      }
      await noOverflow(page);
    });
  }
});
