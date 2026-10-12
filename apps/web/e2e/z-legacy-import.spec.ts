import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { KNOWN_LEGACY_REGISTRY_SHA256 } from '@sgr-registry/domain';
import { clickAdminNavItem, openMobileMenu } from './nav';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ACCOUNTS = {
  admin: 'alexey.viktorov@example.sgr.local',
  superAdmin: 'super.admin@example.sgr.local',
};
const SOURCE_XLSX =
  process.env.LEGACY_ACTS_XLSX ?? '/Users/bolutenko_p/Desktop/Реестры СГР (1) 2 2.xlsx';
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 360, height: 800 },
] as const;
const SCREENSHOT_DIR = resolve(__dirname, '../../../test-results/legacy-import');

let importBatchId = '';

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
    (message) => !message.includes('favicon') && !message.includes('caret-color'),
  );
}

function parseJsonPayload(output: string): Record<string, unknown> {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index];
    if (character === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(output.slice(start, index + 1));
      }
    }
  }
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(objects[index]!) as Record<string, unknown>;
      if (
        parsed.applied != null ||
        parsed.created != null ||
        parsed.rolledBack != null ||
        parsed.alreadyRolledBack != null
      ) {
        return parsed;
      }
    } catch {
      // try an earlier JSON object
    }
  }
  throw new Error(`No import JSON payload in:\n${output.slice(-800)}`);
}

function runDatabaseScript(args: string[], label: string): string {
  const result = spawnSync('pnpm', ['--filter', '@sgr-registry/database', ...args], {
    encoding: 'utf8',
    cwd: resolve(__dirname, '../../..'),
    env: {
      ...process.env,
      SGR_ACTS_IMPORT_CONFIRM: 'sgr_registry_e2e',
    },
  });
  expect(result.status, `${label}: ${result.stderr}\n${result.stdout}`).toBe(0);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/registry/);
}

async function filterImportedOnly(page: Page) {
  await page.getByRole('button', { name: 'Фильтры' }).click();
  await page.getByRole('checkbox', { name: 'Импортированные' }).click();
  await page.getByRole('button', { name: 'Показать результаты' }).click();
}

async function openFirstVisibleAct(page: Page) {
  const card = page.locator('.defect-card').first();
  if ((await card.count()) > 0 && (await card.isVisible())) {
    await card.getByRole('button', { name: 'Открыть' }).click();
  } else {
    await page.locator('.registry-row').first().locator('a[href^="/acts/"]').click();
  }
  await expect(page).toHaveURL(/\/acts\//);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

test.describe('legacy imported acts', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  test.beforeAll(() => {
    test.setTimeout(300_000);
    expect(existsSync(SOURCE_XLSX), `Excel is required at ${SOURCE_XLSX}`).toBe(true);
    const confirm =
      process.env.E2E_DATABASE_URL?.includes('sgr_registry_e2e') ||
      process.env.MIGRATION_DATABASE_URL?.includes('sgr_registry_e2e')
        ? 'sgr_registry_e2e'
        : '';
    expect(confirm).toBe('sgr_registry_e2e');
    const prepared = runDatabaseScript(
      ['exec', 'tsx', 'scripts/prepare-e2e-legacy-engineers.ts', SOURCE_XLSX],
      'prepare e2e engineers',
    );
    expect(prepared).toContain('"created"');
    const imported = runDatabaseScript(
      [
        'acts:import',
        '--',
        `--file=${SOURCE_XLSX}`,
        '--apply',
        `--confirm-database=${confirm}`,
        `--expect-sha256=${KNOWN_LEGACY_REGISTRY_SHA256}`,
      ],
      'full-size import',
    );
    expect(imported).toContain('"applied": true');
    const report = parseJsonPayload(imported);
    expect(report.applied).toBe(true);
    importBatchId = String(report.importBatchId ?? '');
    expect(importBatchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const created = report.created as {
      acts?: number;
      defects?: number;
      engineerLinks?: number;
      unresolvedEngineerReferences?: number;
    };
    expect(created.acts).toBe(169);
    expect(created.defects).toBe(172);
    expect(created.engineerLinks).toBe(82);
    expect(created.unresolvedEngineerReferences).toBe(93);
  });

  test.afterAll(() => {
    if (!importBatchId) {
      return;
    }
    runDatabaseScript(
      [
        'acts:import',
        '--',
        `--rollback-batch=${importBatchId}`,
        '--confirm-database=sgr_registry_e2e',
      ],
      'rollback e2e batch afterAll',
    );
  });

  test('shows full imported registry counts, provenance and unmatched engineers', async ({
    page,
  }) => {
    const errors = attachConsole(page);
    await login(page, ACCOUNTS.admin);
    await page.setViewportSize({ width: 1440, height: 900 });
    await filterImportedOnly(page);
    await expect(page.getByText('Всего: 172')).toBeVisible();
    await expect(page.getByText(/актов: 169/)).toBeVisible();
    await expect(page.getByText('Нет строк')).toHaveCount(0);
    await expect(page.getByText('Статус не указан').first()).toBeVisible();
    await expect(page.getByText('В работе').first()).toBeVisible();
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, 'registry-imported.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Фильтры' }).click();
    await page.getByRole('checkbox', { name: 'Инженеры не сопоставлены' }).click();
    await page.getByRole('button', { name: 'Показать результаты' }).click();
    await page.getByLabel('Поиск').fill('Лазарчик');
    await page.getByLabel('Поиск').press('Enter');
    await expect(page.getByText('Лазарчик Е.В.').first()).toBeVisible();
    await expect(page.getByText('Инженер не сопоставлен').first()).toBeVisible();
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, 'filter-unmatched.png'),
      fullPage: true,
    });
    await openFirstVisibleAct(page);
    await expect(page.getByText('Источник: импортированный реестр')).toBeVisible();
    await expect(page.getByRole('link', { name: /bitrix\.bir\.by\// })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Сопоставить инженера' })).toBeVisible();
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, 'act-unmatched-engineer.png'),
      fullPage: true,
    });
    const list = await page.request.get('/api/registry/defects?pageSize=200&importedOnly=true');
    expect(list.ok()).toBe(true);
    const body = (await list.json()) as {
      totalCount: number;
      actCount: number;
      items: Array<{
        actStatus: string;
        liableOrganizations: Array<{ name: string }>;
        responsibleEngineers: Array<{ unmatched?: boolean; fullName: string }>;
        proposalA: unknown;
        proposalsBC?: unknown[];
      }>;
    };
    expect(body.totalCount).toBe(172);
    expect(body.actCount).toBe(169);
    expect(body.items.some((item) => item.actStatus === 'IMPORTED_UNSPECIFIED')).toBe(true);
    expect(body.items.some((item) => item.actStatus === 'IN_PROGRESS')).toBe(true);
    expect(
      body.items.some(
        (item) =>
          item.liableOrganizations.length > 1 ||
          item.responsibleEngineers.filter((engineer) => !engineer.unmatched).length +
            item.responsibleEngineers.filter((engineer) => engineer.unmatched).length >
            1,
      ),
    ).toBe(true);
    expect(body.items.every((item) => item.proposalA == null)).toBe(true);
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('keeps SUPER_ADMIN read-only and does not overflow viewports', async ({ page }) => {
    const errors = attachConsole(page);
    await login(page, ACCOUNTS.superAdmin);
    await page.getByLabel('Поиск').fill('Лазарчик');
    await expect(page.getByText('Лазарчик Е.В.').first()).toBeVisible();
    await openFirstVisibleAct(page);
    await expect(page.getByText('Источник: импортированный реестр')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Взять в работу' })).toBeVisible();
    await expect(page.getByText('Инженер не сопоставлен').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Сопоставить инженера' })).toBeVisible();
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, 'super-admin-readonly.png'),
      fullPage: true,
    });
    await page.goto('/registry');
    await filterImportedOnly(page);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, `${viewport.width}x${viewport.height}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1.25';
    });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'zoom-125.png'), fullPage: true });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1.5';
    });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'zoom-150.png'), fullPage: true });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1';
    });
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('covers 1920, 1024 and 375 layouts for the imported registry', async ({ page }) => {
    const errors = attachConsole(page);
    const viewports = [
      { width: 1920, height: 1080 },
      { width: 1024, height: 768 },
      { width: 375, height: 812 },
    ] as const;
    await login(page, ACCOUNTS.admin);
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto('/registry');
      await filterImportedOnly(page);
      await expect(page.getByText('Всего: 172')).toBeVisible();
      await expect(page.getByText('Inspired by Andrew Rodkevich')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, `gap-${viewport.width}x${viewport.height}-registry.png`),
      });
      await page.getByRole('button', { name: 'Фильтры' }).click();
      await expect(page.getByRole('checkbox', { name: 'Импортированные' })).toBeVisible();
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, `gap-${viewport.width}x${viewport.height}-filters.png`),
      });
      await page.getByRole('button', { name: 'Показать результаты' }).click();
      await page.getByLabel('Поиск').fill('Лазарчик');
      await page.getByLabel('Поиск').press('Enter');
      await expect(page.getByText('Лазарчик Е.В.').first()).toBeVisible();
      await openFirstVisibleAct(page);
      await expect(page.getByText('Инженер не сопоставлен').first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, `gap-${viewport.width}x${viewport.height}-act.png`),
      });
      await page.getByRole('button', { name: 'Сопоставить инженера' }).click();
      const engineerSelect = page.getByLabel('Учётная запись инженера');
      await expect(engineerSelect).toBeVisible();
      expect((await engineerSelect.locator('option').allTextContents()).join('\n')).not.toMatch(
        /@/,
      );
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, `gap-${viewport.width}x${viewport.height}-dialog.png`),
      });
      await page.goto('/registry');
      if (viewport.width < 1280) {
        await openMobileMenu(page);
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.screenshot({
          path: resolve(SCREENSHOT_DIR, `gap-${viewport.width}x${viewport.height}-drawer.png`),
        });
        await page.keyboard.press('Escape');
      }
      await clickAdminNavItem(page, 'Пользователи');
      await expect(page.getByRole('heading', { name: 'Пользователи' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      const bodyText = await page.locator('body').innerText();
      expect(bodyText).not.toContain('undefined');
      expect(bodyText).not.toMatch(/\bnull\b/);
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, `gap-${viewport.width}x${viewport.height}-users.png`),
      });
    }
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('ADMIN can manually resolve an unmatched engineer', async ({ page }) => {
    const errors = attachConsole(page);
    await login(page, ACCOUNTS.admin);
    await page.getByLabel('Поиск').fill('Лазарчик');
    await expect(page.getByText('Лазарчик Е.В.').first()).toBeVisible();
    await openFirstVisibleAct(page);
    await page.getByRole('button', { name: 'Сопоставить инженера' }).click();
    await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'manual-resolve.png'), fullPage: true });
    const engineerSelect = page.getByLabel('Учётная запись инженера');
    const firstEngineerValue = await engineerSelect.locator('option').nth(1).getAttribute('value');
    expect(firstEngineerValue).toBeTruthy();
    expect(await engineerSelect.textContent()).not.toMatch(/@/);
    await engineerSelect.selectOption(firstEngineerValue!);
    await page.getByRole('button', { name: 'Сопоставить', exact: true }).click();
    await expect(page.getByText('Инженер сопоставлен')).toBeVisible();
    expect(applicationErrors(errors)).toEqual([]);
  });

  test('rolls back only the e2e import batch', async () => {
    expect(importBatchId).toBeTruthy();
    const rolled = runDatabaseScript(
      [
        'acts:import',
        '--',
        `--rollback-batch=${importBatchId}`,
        '--confirm-database=sgr_registry_e2e',
      ],
      'rollback e2e batch',
    );
    const report = parseJsonPayload(rolled);
    expect(report.rolledBack === true || report.alreadyRolledBack === true).toBe(true);
    const again = runDatabaseScript(
      [
        'acts:import',
        '--',
        `--rollback-batch=${importBatchId}`,
        '--confirm-database=sgr_registry_e2e',
      ],
      'repeat rollback',
    );
    expect(parseJsonPayload(again).alreadyRolledBack).toBe(true);
  });
});
