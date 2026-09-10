import { expect, test, type Page } from '@playwright/test';
import { e2eApiOrigin } from './e2e-origins';
import { DESKTOP_NAV_MIN_WIDTH } from './nav';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ACCOUNTS = {
  admin: 'alexey.viktorov@example.sgr.local',
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

async function noPageOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

async function openAssignedAct(page: Page) {
  await page.getByPlaceholder('Номер акта, объект, адрес, заказчик…').fill('квартира 45');
  await page.getByPlaceholder('Номер акта, объект, адрес, заказчик…').press('Enter');
  await expect(page.getByText('Подъезд 2, квартира 45, санузел').first()).toBeVisible();
  const actLink = page.getByRole('link', { name: /С-1-2026-000001/ });
  const cardOpen = page
    .locator('.defect-card')
    .filter({ hasText: 'квартира 45' })
    .getByRole('button', { name: 'Открыть', exact: true });
  const opener = actLink.or(cardOpen).first();
  await expect(opener).toBeVisible();
  await opener.click();
  await expect(page).toHaveURL(/\/acts\//, { timeout: 15_000 });
  await expect(page.locator('.act-detail')).toBeVisible();
}

function chatThread(page: Page) {
  return page.locator('[data-slot="act-chat-thread"]');
}

async function expectMessageSent(page: Page, text: string | RegExp) {
  await expect(page.getByLabel('Сообщение')).toHaveValue('');
  await expect(chatThread(page).getByText(text)).toBeVisible();
}

async function logout(page: Page) {
  const width = page.viewportSize()?.width ?? 1440;
  if (width < DESKTOP_NAV_MIN_WIDTH) {
    await page.getByRole('button', { name: 'Открыть меню' }).click();
    await page.getByRole('button', { name: 'Выйти' }).click();
  } else {
    await page.getByRole('button', { name: 'Меню пользователя' }).click();
    await page.getByRole('menuitem', { name: 'Выйти' }).click();
  }
  await expect(page).toHaveURL(/\/login/);
}

test.describe('act discussion chat', () => {
  test('desktop sending, mentions, notifications and contractor isolation', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    const token = Date.now().toString(36);
    for (const size of [
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(size);
      await login(page, ACCOUNTS.admin);
      await openAssignedAct(page);
      await expect(page.getByRole('tab', { name: 'Обсуждение' })).toBeVisible();
      await page.getByRole('tab', { name: 'Обсуждение' }).click();
      await expect(page.locator('#act-discussion')).toBeVisible();
      const draft = page.getByLabel('Сообщение');
      await draft.fill(`Проверьте срок ${token} ${size.width}`);
      await page.getByRole('button', { name: 'Отправить' }).click();
      await expectMessageSent(page, `Проверьте срок ${token} ${size.width}`);
      await noPageOverflow(page);
      await logout(page);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ACCOUNTS.admin);
    await openAssignedAct(page);
    await page.getByRole('tab', { name: 'Обсуждение' }).click();
    const draft = page.getByLabel('Сообщение');
    await draft.fill('@Дми');
    await expect(page.getByRole('option', { name: /Орлов Дмитрий/ })).toBeVisible();
    await draft.press('Enter');
    await expect(draft).toHaveValue(/@Орлов Дмитрий/);
    await draft.press('End');
    await draft.fill(`${await draft.inputValue()} смотрите ${token}`);
    await draft.press('Enter');
    await expectMessageSent(page, `смотрите ${token}`);
    await expect(
      chatThread(page)
        .locator('li')
        .filter({ hasText: `смотрите ${token}` })
        .getByText('@Орлов Дмитрий', { exact: true })
        .first(),
    ).toBeVisible();

    const long = `длинное-${token}-${'слово'.repeat(80)} https://example.sgr.local/path`;
    await draft.fill(long);
    await page.getByRole('button', { name: 'Отправить' }).click();
    await expectMessageSent(page, long);
    await noPageOverflow(page);

    await draft.fill(`первая строка ${token}`);
    await draft.press('Shift+Enter');
    await draft.type('вторая строка');
    await page.getByRole('button', { name: 'Отправить' }).click();
    await expectMessageSent(page, new RegExp(`первая строка ${token}\\s+вторая строка`));

    await logout(page);
    await login(page, ACCOUNTS.responsible);
    await page.getByRole('button', { name: /Уведомления/ }).click();
    await page.getByRole('menuitem', { name: 'Все уведомления' }).click();
    await expect(page).toHaveURL(/\/notifications/);
    await page.getByRole('button', { name: 'Непрочитанные' }).click();
    const mentionCard = page.locator('li').filter({ hasText: 'Упоминание в обсуждении' });
    await expect(mentionCard.first()).toBeVisible();
    await mentionCard.first().getByRole('button', { name: 'Открыть', exact: true }).click();
    await expect(page).toHaveURL(/tab=discussion/);
    await expect(page.locator('#act-discussion')).toBeVisible();
    await expect(chatThread(page).getByText(`смотрите ${token}`)).toBeVisible();
    await page.getByLabel('Сообщение').fill(`Ответ инженера ${token}`);
    await page.getByRole('button', { name: 'Отправить' }).click();
    await expectMessageSent(page, `Ответ инженера ${token}`);

    await logout(page);
    await login(page, ACCOUNTS.contractor);
    await openAssignedAct(page);
    const actUrl = page.url();
    const actId = actUrl.split('/acts/')[1]?.split('?')[0];
    await expect(page.getByRole('tab', { name: 'Обсуждение' })).toHaveCount(0);
    await expect(page.locator('#act-discussion')).toHaveCount(0);
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const chat = await request.get(`${e2eApiOrigin()}/api/acts/${actId}/chat`, {
      headers: { cookie: cookieHeader },
    });
    expect(chat.status()).toBe(403);
    expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
    expect(
      consoleErrors.filter(
        (message) =>
          !message.includes('favicon') && !message.includes('Download the React DevTools'),
      ),
    ).toEqual([]);
  });

  test('mobile layout, touch mention and contractor hide', async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const token = `m${Date.now().toString(36)}`;
    for (const size of [
      { width: 390, height: 844 },
      { width: 360, height: 800 },
      { width: 768, height: 1024 },
    ]) {
      await page.setViewportSize(size);
      await login(page, ACCOUNTS.admin);
      await openAssignedAct(page);
      await page.getByRole('tab', { name: 'Обсуждение' }).click();
      await expect(page.locator('#act-discussion')).toBeVisible();
      const draft = page.getByLabel('Сообщение');
      const send = page.getByRole('button', { name: 'Отправить' });
      await expect(draft).toBeVisible();
      await expect(send).toBeVisible();
      await draft.scrollIntoViewIfNeeded();
      await send.scrollIntoViewIfNeeded();
      const sendBox = await send.boundingBox();
      expect((sendBox?.height ?? 0) >= 40).toBe(true);
      await draft.fill(`@Дм`);
      const listbox = page.getByRole('listbox', { name: 'Сотрудники' });
      const option = page.getByRole('option', { name: /Орлов Дмитрий/ });
      await expect(option).toBeVisible();
      await expect
        .poll(async () => {
          const box = await listbox.boundingBox();
          const viewport = page.viewportSize();
          if (!box || !viewport) {
            return `missing box=${JSON.stringify(box)} viewport=${JSON.stringify(viewport)}`;
          }
          const inView =
            box.y >= -8 &&
            box.y + box.height <= viewport.height + 8 &&
            box.x >= -8 &&
            box.x + box.width <= viewport.width + 8;
          return inView ? 'ok' : JSON.stringify({ box, viewport });
        })
        .toBe('ok');
      await option.tap().catch(async () => {
        await option.click();
      });
      await expect(draft).toBeFocused();
      await draft.fill(`Мобильное ${token} ${size.width} ${'оченьдлинноеслово'.repeat(12)}`);
      await send.click();
      await expectMessageSent(page, `Мобильное ${token} ${size.width}`);
      await noPageOverflow(page);
      await logout(page);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, ACCOUNTS.contractor);
    await openAssignedAct(page);
    await expect(page.getByRole('tab', { name: 'Обсуждение' })).toHaveCount(0);
    await noPageOverflow(page);
    expect(errors.filter((message) => !message.includes('favicon'))).toEqual([]);
  });
});
