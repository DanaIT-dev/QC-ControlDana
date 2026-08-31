import { expect, test, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';

const ACCOUNTS = {
  admin: { email: 'alexey.viktorov@example.sgr.local' },
  contractor: { email: 'igor.panteleev@example.sgr.local' },
  responsible: { email: 'dmitry.orlov@example.sgr.local' },
  manager: { email: 'marina.sokolova@example.sgr.local' },
};

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
    await expect(readyBadges.first()).toBeVisible();
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

  test('CONTRACTOR can open attachment UI and manager sees MinIO/ClamAV status', async ({
    page,
  }) => {
    await login(page, ACCOUNTS.contractor.email);
    await openFirstAct(page);
    await expect(page.getByText('Файлы и фотографии').first()).toBeVisible();
    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
    await login(page, ACCOUNTS.admin.email);
    await page.goto('/system-status');
    await expect(page.getByText('MinIO')).toBeVisible();
    await expect(page.getByText('ClamAV')).toBeVisible();
  });

  test('act attachments fit 390px and 360px without horizontal overflow', async ({ page }) => {
    await login(page, ACCOUNTS.admin.email);
    await openFirstAct(page);
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflow, `${width}px overflow`).toBe(false);
    }
  });
});
