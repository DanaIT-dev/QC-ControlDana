import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ARTIFACTS = resolve(process.cwd(), 'test-results/ui-review');
const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ADMIN = 'alexey.viktorov@example.sgr.local';
const SUPER_ADMIN = 'super.admin@example.sgr.local';

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, label: 'desktop' },
  tablet: { width: 768, height: 1024, label: 'tablet' },
  mobile: { width: 390, height: 844, label: 'mobile' },
} as const;

const PAGE_SPECS = [
  {
    slug: 'notifications',
    route: '/notifications',
    role: 'admin' as const,
    heading: 'Уведомления',
  },
  {
    slug: 'reference-data',
    route: '/reference-data',
    role: 'admin' as const,
    heading: 'Справочники',
  },
  { slug: 'history', route: '/history', role: 'admin' as const, heading: 'Журнал аудита' },
  { slug: 'users', route: '/users', role: 'admin' as const, heading: 'Пользователи' },
  {
    slug: 'system-status-admin',
    route: '/system-status',
    role: 'admin' as const,
    heading: 'Техническое состояние системы',
  },
  {
    slug: 'system-status-super-admin',
    route: '/system-status',
    role: 'super-admin' as const,
    heading: 'Техническое состояние системы',
  },
  {
    slug: 'super-admin',
    route: '/super-admin',
    role: 'super-admin' as const,
    heading: 'Администраторы',
  },
  { slug: 'pending-role', route: '/pending-role', role: 'pending' as const, heading: null },
] as const;

async function login(page: Page, email: string, password = DEMO_PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

async function resetSession(page: Page) {
  await resetChromiumZoom(page);
  await page.context().clearCookies();
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Электронная почта')).toBeVisible({ timeout: 20_000 });
}

async function logout(page: Page) {
  const menu = page.getByRole('button', { name: 'Меню пользователя' });
  if (await menu.isVisible()) {
    await menu.click({ force: true });
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);
    return;
  }
  await resetSession(page);
}

async function loginAsAdmin(page: Page) {
  await login(page, ADMIN);
  await expect(page).toHaveURL(/\/registry/);
}

async function loginAsSuperAdmin(page: Page) {
  await login(page, SUPER_ADMIN);
  await expect(page).toHaveURL(/\/registry/);
}

async function loginAsPendingUser(page: Page) {
  await loginAsSuperAdmin(page);
  await page.goto('/users');
  await page.getByRole('button', { name: 'Добавить пользователя' }).click();
  const stamp = Date.now();
  const pendingEmail = `e2e.visual.pending.${stamp}@example.sgr.local`;
  await page.getByLabel('ФИО').fill(`Е2Е Визуал ${stamp}`);
  await page.getByLabel('Электронная почта').fill(pendingEmail);
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  const pendingPassword = (await page.locator('.temp-password').innerText()).trim();
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await logout(page);
  await login(page, pendingEmail, pendingPassword);
  await expect(page).toHaveURL(/\/change-password/);
  await page.getByLabel('Текущий пароль').fill(pendingPassword);
  await page.getByLabel('Новый пароль').fill('Dana-SGR-WaitRole-2026!');
  await page.getByRole('button', { name: 'Сменить пароль' }).click();
  await expect(page).toHaveURL(/\/pending-role/);
}

async function loginForRole(page: Page, role: 'admin' | 'super-admin' | 'pending') {
  if (role === 'admin') {
    await loginAsAdmin(page);
    return;
  }
  if (role === 'super-admin') {
    await loginAsSuperAdmin(page);
    return;
  }
  await loginAsPendingUser(page);
}

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

function applicationErrors(errors: string[]) {
  return errors.filter(
    (message) =>
      !message.includes('favicon') &&
      !message.includes('hydrated but some attributes') &&
      !message.includes('caret-color'),
  );
}

async function screenshotPage(page: Page, filename: string) {
  const path = `${ARTIFACTS}/${filename}`;
  await page.screenshot({ path, fullPage: true });
  expect(existsSync(path)).toBe(true);
  expect(statSync(path).size).toBeGreaterThan(1024);
}

async function setChromiumZoom(page: Page, scale: number) {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: scale });
}

async function resetChromiumZoom(page: Page) {
  await setChromiumZoom(page, 1);
}

async function readZoomScale(page: Page) {
  return page.evaluate(() => window.visualViewport?.scale ?? 1);
}

async function assertPageContent(page: Page, spec: (typeof PAGE_SPECS)[number]) {
  if (spec.slug === 'pending-role') {
    await expect(
      page.getByText('Учетная запись создана. Ожидается назначение роли администратором'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Реестр' })).toHaveCount(0);
    return;
  }
  if (spec.slug === 'super-admin') {
    await expect(page.getByRole('heading', { name: 'Администраторы', exact: true })).toBeVisible();
    return;
  }
  await expect(page.getByRole('heading', { name: spec.heading! })).toBeVisible();
  if (spec.slug === 'system-status-super-admin') {
    await expect(page.locator('[data-slot="notification-settings-readonly"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: 'Сохранить настройки' })).toHaveCount(0);
    return;
  }
  if (spec.slug === 'system-status-admin') {
    await expect(page.getByText('Настройки уведомлений')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Сохранить настройки' })).toBeVisible({
      timeout: 20_000,
    });
  }
}

test.describe('UI visual review', () => {
  test.beforeAll(() => {
    mkdirSync(ARTIFACTS, { recursive: true });
    const result = spawnSync(
      'pnpm',
      ['--filter', '@sgr-registry/database', 'exec', 'tsx', 'scripts/ensure-test-super-admin.ts'],
      { cwd: resolve(process.cwd()), encoding: 'utf8', env: process.env },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'Failed to provision test SUPER_ADMIN');
    }
  });

  test('captures required page screenshots across desktop, tablet and mobile', async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });

    let currentRole: 'admin' | 'super-admin' | 'pending' | null = null;

    for (const spec of PAGE_SPECS) {
      if (currentRole !== spec.role) {
        if (currentRole !== null) {
          await resetChromiumZoom(page);
          await resetSession(page);
        }
        await loginForRole(page, spec.role);
        currentRole = spec.role;
      }

      for (const viewport of Object.values(VIEWPORTS)) {
        await page.setViewportSize(viewport);
        await page.goto(spec.route);
        await assertPageContent(page, spec);
        await noOverflow(page);
        await screenshotPage(page, `${spec.slug}--${spec.role}--${viewport.label}.png`);
      }
    }

    const files = readdirSync(ARTIFACTS).filter((name) => name.endsWith('.png'));
    for (const spec of PAGE_SPECS) {
      for (const viewport of Object.values(VIEWPORTS)) {
        expect(files).toContain(`${spec.slug}--${spec.role}--${viewport.label}.png`);
      }
    }
    expect(files.length).toBeGreaterThanOrEqual(PAGE_SPECS.length * 3);
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('desktop browser zoom 125% and 150% keeps required pages usable', async ({ page }) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });

    const zoomPages: (typeof PAGE_SPECS)[number][] = [
      ...PAGE_SPECS.filter((spec) => spec.slug !== 'pending-role'),
      ...PAGE_SPECS.filter((spec) => spec.slug === 'pending-role'),
    ];

    for (const scale of [1.25, 1.5] as const) {
      await resetSession(page);
      let currentRole: 'admin' | 'super-admin' | 'pending' | null = null;
      for (const spec of zoomPages) {
        if (currentRole !== spec.role) {
          if (currentRole !== null) {
            await resetSession(page);
          }
          await loginForRole(page, spec.role);
          currentRole = spec.role;
        }
        await page.setViewportSize(VIEWPORTS.desktop);
        await page.goto(spec.route);
        await setChromiumZoom(page, scale);
        expect(await readZoomScale(page)).toBeCloseTo(scale, 2);
        await assertPageContent(page, spec);
        await noOverflow(page);
        await screenshotPage(
          page,
          `${spec.slug}--${spec.role}--desktop--zoom-${Math.round(scale * 100)}.png`,
        );
      }
    }

    await resetSession(page);
    await loginAsAdmin(page);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/system-status');
    await setChromiumZoom(page, 1.25);
    await expect(page.getByText('Настройки уведомлений')).toBeVisible();
    await screenshotPage(page, 'system-status-admin--admin--desktop--zoom-125--detail.png');

    await resetSession(page);
    await loginAsSuperAdmin(page);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto('/system-status');
    await setChromiumZoom(page, 1.5);
    await expect(page.locator('[data-slot="notification-settings-readonly"]')).toBeVisible({
      timeout: 20_000,
    });
    await screenshotPage(
      page,
      'system-status-super-admin--super-admin--desktop--zoom-150--detail.png',
    );

    expect(applicationErrors(errors)).toEqual([]);
  });
});
