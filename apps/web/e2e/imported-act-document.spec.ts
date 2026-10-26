import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

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

function pdfBuffer(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\nstream\nimported-scan\nendstream\n%%EOF\n');
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

let createdActId = '';

function deleteImportedAct(actId: string) {
  if (!actId) {
    return;
  }
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      '@sgr-registry/database',
      'exec',
      'tsx',
      'scripts/insert-e2e-imported-document-fixture.ts',
    ],
    {
      cwd: resolve(__dirname, '../../..'),
      env: { ...process.env, FIXTURE_DELETE_ACT_ID: actId },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || 'fixture cleanup failed');
  }
}

function importedActId(): string {
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      '@sgr-registry/database',
      'exec',
      'tsx',
      'scripts/insert-e2e-imported-document-fixture.ts',
    ],
    {
      cwd: resolve(__dirname, '../../..'),
      env: process.env,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || 'fixture failed');
  }
  const actId = result.stdout.trim().split('\n').at(-1) ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(actId)) {
    throw new Error('fixture did not return an act id');
  }
  return actId;
}

test.describe('imported act document link', () => {
  test.afterAll(() => {
    deleteImportedAct(createdActId);
  });

  test('clears the editable link and keeps the Bitrix source and the scan', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = attachConsole(page);
    const actId = importedActId();
    createdActId = actId;
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto(`/acts/${actId}`);
    await expect(page.getByText('7.1').first()).toBeVisible();
    await expect(page.getByText('Internal server error')).toHaveCount(0);

    await page.getByRole('button', { name: 'Загрузить' }).first().click();
    await page.locator('#attachment-file').setInputFiles({
      name: 'imported-scan.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBuffer(),
    });
    await expect(page.getByText('Готово').first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('imported-scan.pdf').first()).toBeVisible();

    await page.getByRole('button', { name: 'Изменить данные акта' }).click();
    const link = page.getByLabel('Ссылка на документ');
    await expect(link).toHaveValue('');
    await link.fill('https://files.example.sgr.local/temporary.pdf');
    await link.fill('');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Данные акта сохранены')).toBeVisible();
    await expect(page.getByText('Internal server error')).toHaveCount(0);

    await page.reload();
    await expect(
      page.getByRole('link', { name: 'Bitrix — Открыть исходный документ' }),
    ).toBeVisible();
    await expect(page.getByText('imported-scan.pdf').first()).toBeVisible();
    await page.getByRole('button', { name: 'Изменить данные акта' }).click();
    await expect(page.getByLabel('Ссылка на документ')).toHaveValue('');
    await expect(page.getByText('undefined')).toHaveCount(0);
    await expect(page.getByText('null', { exact: true })).toHaveCount(0);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.evaluate((zoom) => {
        document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom);
      }, viewport.zoom);
      await noOverflow(page, viewport.zoom);
    }
    await page.evaluate(() => {
      document.documentElement.style.zoom = '';
    });
    expect(applicationErrors(errors)).toEqual([]);
  });
});
