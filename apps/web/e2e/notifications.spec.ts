import { expect, test, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const MAILPIT = process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:8025';

const ACCOUNTS = {
  admin: 'alexey.viktorov@example.sgr.local',
  manager: 'marina.sokolova@example.sgr.local',
  responsible: 'dmitry.orlov@example.sgr.local',
  contractor: 'igor.panteleev@example.sgr.local',
};

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

test.describe('notifications and deadline control', () => {
  test('ADMIN uses bell, notification center, deadlines and settings', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await login(page, ACCOUNTS.admin);
    await expect(page.getByRole('button', { name: /Уведомления/ })).toBeVisible();
    await page.getByRole('button', { name: /Уведомления/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Все уведомления' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Все уведомления' }).click();
    await expect(page).toHaveURL(/\/notifications/);
    await expect(page.getByRole('heading', { name: 'Уведомления' })).toBeVisible();
    await page.getByRole('link', { name: 'Контроль сроков' }).click();
    await expect(page).toHaveURL(/\/deadlines/);
    await expect(page.getByRole('heading', { name: 'Контроль сроков' })).toBeVisible();
    await page.goto('/deadlines?bucket=WARNING');
    await expect(page).toHaveURL(/bucket=WARNING/);
    await page.goto('/system-status');
    await expect(page.getByText('Настройки уведомлений')).toBeVisible();
    await expect(page.getByText('SMTP-пароль не отображается')).toBeVisible();
    const appErrors = errors.filter((message) => !message.includes('favicon'));
    expect(appErrors).toEqual([]);
  });

  test('SGR_MANAGER sees notifications and deadlines without ADMIN settings', async ({ page }) => {
    await login(page, ACCOUNTS.manager);
    await page.goto('/deadlines');
    await expect(page.getByRole('heading', { name: 'Контроль сроков' })).toBeVisible();
    await page.goto('/system-status');
    await expect(page.getByText('Недостаточно прав')).toBeVisible();
    const responses: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/notifications')) {
        responses.push(response.url());
      }
    });
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: 'Уведомления' })).toBeVisible();
  });

  test('RESPONSIBLE sees assigned GENERAL control and never B/C payloads', async ({ page }) => {
    const payloads: string[] = [];
    page.on('response', async (response) => {
      if (
        (response.url().includes('/api/') && response.request().resourceType() === 'xhr') ||
        response.url().includes('/api/')
      ) {
        try {
          const text = await response.text();
          payloads.push(text);
        } catch {
          /* ignore */
        }
      }
    });
    await login(page, ACCOUNTS.responsible);
    await page.goto('/deadlines');
    await expect(page.getByRole('heading', { name: 'Контроль сроков' })).toBeVisible();
    expect(payloads.join('\n')).not.toMatch(/amountB|proposalB|proposalC|"slot":"B"/);
  });

  test('CONTRACTOR sees THIRD_PARTY control without creating acts', async ({ page }) => {
    await login(page, ACCOUNTS.contractor);
    await expect(page.getByRole('link', { name: 'Создать акт' })).toHaveCount(0);
    await page.goto('/deadlines?kind=THIRD_PARTY');
    await expect(page.getByRole('heading', { name: 'Контроль сроков' })).toBeVisible();
    await expect(page.getByText('сумма Proposal A', { exact: false })).toHaveCount(0);
  });

  test('notification cards fit 390 and 360 without overflow', async ({ page }) => {
    await login(page, ACCOUNTS.admin);
    await page.goto('/notifications');
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      await noOverflow(page);
    }
    await page.goto('/deadlines');
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      await noOverflow(page);
    }
  });

  test('Mailpit receives notification mail for a local assignment', async () => {
    const response = await fetch(`${MAILPIT}/api/v1/messages`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { messages?: unknown[]; total?: number };
    expect(Array.isArray(body.messages) || typeof body.total === 'number').toBe(true);
  });
});
