import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

const ACCOUNTS = {
  admin: { email: 'alexey.viktorov@example.sgr.local' },
  contractor: { email: 'igor.panteleev@example.sgr.local' },
  responsible: { email: 'dmitry.orlov@example.sgr.local' },
  manager: { email: 'marina.sokolova@example.sgr.local' },
};

function eicarBuffer(): Buffer {
  const body = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(
    '',
  );
  return Buffer.from(body);
}

function pdfBuffer(payload: string): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\nstream\n${payload}\nendstream\n%%EOF\n`);
}

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/registry/);
}

async function openFirstAct(page: Page) {
  await page.locator('a[href^="/acts/"]:not([href="/acts/new"])').first().click();
  await expect(page.getByText('Вложения акта')).toBeVisible();
}

test.describe('attachments', () => {
  test('ADMIN uploads a PDF and sees READY without skeleton leftovers', async ({ page }) => {
    await login(page, ACCOUNTS.admin.email);
    await openFirstAct(page);
    const readyBadges = page.getByText('Готово');
    const readyBefore = await readyBadges.count();
    await page.getByRole('button', { name: 'Загрузить' }).first().click();
    await expect(page.getByRole('heading', { name: 'Загрузка файла' })).toBeVisible();
    await page.locator('#attachment-file').setInputFiles({
      name: 'act-scan.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBuffer(`playwright-${Date.now()}`),
    });
    await expect(readyBadges).toHaveCount(readyBefore + 1, { timeout: 90_000 });
    await page.screenshot({ path: 'apps/web/e2e/artifacts/attachments-ready.png' });
  });

  test('RESPONSIBLE never sees proposal B/C attachment panels', async ({ page }) => {
    await login(page, ACCOUNTS.responsible.email);
    await openFirstAct(page);
    await expect(page.getByText('Документы предложения B')).toHaveCount(0);
    await expect(page.getByText('Документы предложения C')).toHaveCount(0);
    await expect(page.getByText('Вложения акта')).toBeVisible();
  });

  test('CONTRACTOR can open attachment UI and manager sees storage/ClamAV status', async ({
    page,
  }) => {
    await login(page, ACCOUNTS.contractor.email);
    await openFirstAct(page);
    await expect(page.getByText('Файлы и фотографии').first()).toBeVisible();
    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await login(page, ACCOUNTS.admin.email);
    await page.goto('/system-status');
    await expect(page.getByText('Хранилище')).toBeVisible();
    await expect(page.getByText('ClamAV')).toBeVisible();
  });

  test('act attachments fit required viewports and zoom without overflow', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await login(page, ACCOUNTS.admin.email);
    await openFirstAct(page);
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
      { width: 360, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflow, `${viewport.width}px overflow`).toBe(false);
      const bodyText = await page.locator('body').innerText();
      expect(bodyText).not.toMatch(/\bundefined\b|\bnull\b/);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const zoom of ['1.25', '1.5']) {
      await page.evaluate((value) => {
        document.documentElement.style.zoom = value;
      }, zoom);
      const zoomed = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(zoomed, `${zoom} zoom overflow`).toBe(false);
    }
    expect(consoleErrors).toEqual([]);
  });

  test('ADMIN download stays free of storage credentials and EICAR is rejected', async ({
    page,
  }) => {
    const leaks: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (/X-Amz-|AWSAccessKeyId|presigned|S3_SECRET|sgr_minio/i.test(text)) {
        leaks.push(text);
      }
    });
    await login(page, ACCOUNTS.admin.email);
    await openFirstAct(page);
    await page.getByRole('button', { name: 'Загрузить' }).first().click();
    await page.locator('#attachment-file').setInputFiles({
      name: 'download-check.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBuffer(`download-${Date.now()}`),
    });
    const ready = page.getByText('Готово');
    await expect(ready.first()).toBeVisible({ timeout: 90_000 });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Скачать' }).first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().length).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Загрузить' }).first().click();
    await page.locator('#attachment-file').setInputFiles({
      name: 'threat.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBuffer(
        `clean-prefix SGR-ATTACHMENT-TEST-THREAT ${eicarBuffer().toString('utf8')}`,
      ),
    });
    await expect(page.getByText('Отклонено').first()).toBeVisible({ timeout: 90_000 });
    const html = await page.content();
    expect(html).not.toMatch(/X-Amz-|AWSAccessKeyId|presigned/i);
    expect(leaks).toEqual([]);
  });

  test('upload fails while storage is down and succeeds after it returns', async ({ page }) => {
    await login(page, ACCOUNTS.admin.email);
    await openFirstAct(page);
    execFileSync('docker', ['stop', 'sgr-registry-object-storage']);
    try {
      await page.getByRole('button', { name: 'Загрузить' }).first().click();
      await page.locator('#attachment-file').setInputFiles({
        name: 'offline.pdf',
        mimeType: 'application/pdf',
        buffer: pdfBuffer(`offline-${Date.now()}`),
      });
      await expect(page.getByText('Не удалось загрузить файл')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Close' }).click();
    } finally {
      execFileSync('docker', ['start', 'sgr-registry-object-storage']);
    }
    await expect
      .poll(
        () =>
          execFileSync(
            'docker',
            ['inspect', '-f', '{{.State.Health.Status}}', 'sgr-registry-object-storage'],
            { encoding: 'utf8' },
          ).trim(),
        { timeout: 30_000 },
      )
      .toBe('healthy');
    await page.getByRole('button', { name: 'Загрузить' }).first().click();
    await page.locator('#attachment-file').setInputFiles({
      name: 'recovered.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBuffer(`recovered-${Date.now()}`),
    });
    await expect(page.getByText('Готово').first()).toBeVisible({ timeout: 90_000 });
  });
});
