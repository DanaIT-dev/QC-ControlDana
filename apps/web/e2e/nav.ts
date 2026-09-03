import { expect, type Page } from '@playwright/test';

export const DESKTOP_NAV_MIN_WIDTH = 1280;

export function isCompactNav(page: Page): boolean {
  return (page.viewportSize()?.width ?? DESKTOP_NAV_MIN_WIDTH) < DESKTOP_NAV_MIN_WIDTH;
}

export async function openMobileMenu(page: Page) {
  const trigger = page.getByRole('button', { name: 'Открыть меню' });
  await expect(trigger).toBeVisible();
  if ((await page.getByRole('dialog').count()) === 0) {
    await trigger.click();
  }
  await expect(page.getByRole('dialog')).toBeVisible();
}

export async function clickPrimaryNavItem(page: Page, name: string) {
  if (isCompactNav(page)) {
    await openMobileMenu(page);
    await page.getByRole('dialog').getByRole('link', { name, exact: true }).click();
    return;
  }
  await page
    .getByRole('navigation', { name: 'Основная навигация' })
    .getByRole('link', { name, exact: true })
    .click();
}

export async function clickAdminNavItem(page: Page, name: string) {
  if (isCompactNav(page)) {
    await openMobileMenu(page);
    await page.getByRole('dialog').getByRole('link', { name, exact: true }).click();
    return;
  }
  const trigger = page.getByRole('button', { name: 'Администрирование' });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

export async function expectPrimaryNavItem(page: Page, name: string, visible: boolean) {
  if (isCompactNav(page)) {
    await openMobileMenu(page);
    const link = page.getByRole('dialog').getByRole('link', { name, exact: true });
    if (visible) {
      await expect(link).toBeVisible();
    } else {
      await expect(link).toHaveCount(0);
    }
    await page.keyboard.press('Escape');
    return;
  }
  const link = page
    .getByRole('navigation', { name: 'Основная навигация' })
    .getByRole('link', { name, exact: true });
  if (visible) {
    await expect(link).toBeVisible();
  } else {
    await expect(link).toHaveCount(0);
  }
}

export async function expectAdminNavItem(page: Page, name: string, visible: boolean) {
  if (isCompactNav(page)) {
    await openMobileMenu(page);
    const link = page.getByRole('dialog').getByRole('link', { name, exact: true });
    if (visible) {
      await expect(link).toBeVisible();
    } else {
      await expect(link).toHaveCount(0);
    }
    await page.keyboard.press('Escape');
    return;
  }
  const trigger = page.getByRole('button', { name: 'Администрирование' });
  if (!visible) {
    if ((await trigger.count()) === 0) {
      return;
    }
    await trigger.click();
    await expect(page.getByRole('menuitem', { name, exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    return;
  }
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
}

export async function expectNoAdminMenu(page: Page) {
  if (isCompactNav(page)) {
    await openMobileMenu(page);
    await expect(
      page.getByRole('dialog').getByText('Администрирование', { exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    return;
  }
  await expect(page.getByRole('button', { name: 'Администрирование' })).toHaveCount(0);
}
