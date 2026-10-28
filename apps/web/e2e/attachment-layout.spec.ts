import { mkdirSync } from 'node:fs';
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

const DEMO_PASSWORD = 'Dana-SGR-Demo-2026!';
const ADMIN = 'alexey.viktorov@example.sgr.local';
const LONG_NAME = '30.8 (15.4) – дефектный акт (С-1) от 05.08.2026 (6 дефектных отделки).pdf';
const VIEWPORTS = [
  { width: 1920, height: 1080, zoom: 1, shot: 'desktop' },
  { width: 1440, height: 900, zoom: 1, shot: 'desktop-1440' },
  { width: 1024, height: 768, zoom: 1, shot: null },
  { width: 768, height: 1024, zoom: 1, shot: 'tablet' },
  { width: 700, height: 900, zoom: 1, shot: 'split' },
  { width: 640, height: 900, zoom: 1, shot: null },
  { width: 540, height: 900, zoom: 1, shot: null },
  { width: 390, height: 844, zoom: 1, shot: 'mobile' },
  { width: 375, height: 812, zoom: 1, shot: null },
  { width: 360, height: 800, zoom: 1, shot: 'mobile-360' },
  { width: 1440, height: 900, zoom: 1.25, shot: null },
  { width: 1440, height: 900, zoom: 1.5, shot: null },
] as const;

function pdfBuffer(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\nstream\nlayout-check\nendstream\n%%EOF\n');
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

test('long attachment names stay readable across viewports', async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync('apps/web/e2e/artifacts', { recursive: true });
  const errors = attachConsole(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.locator('a[href^="/acts/"]:not([href="/acts/new"])').first().click();
  await expect(page.getByText('Вложения акта')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Добавить файлы' })).toBeVisible();
  await page.getByRole('button', { name: 'Добавить файлы' }).click();
  await page.locator('#attachment-file').setInputFiles({
    name: LONG_NAME,
    mimeType: 'application/pdf',
    buffer: pdfBuffer(),
  });
  const row = page.locator('[data-slot="attachment-row"]').filter({ hasText: LONG_NAME });
  await expect(row.getByText('Готово', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(row.locator('[data-slot="attachment-meta"]')).toContainText('PDF');
  await expect(page.locator('body')).not.toContainText(/bitrix/i);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom);
    }, viewport.zoom);
    const label = `${viewport.width}x${viewport.height}@${viewport.zoom}`;
    await row.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    const layout = await row.evaluate((element) => {
      const name = element.querySelector('[data-slot="attachment-name"]');
      const actions = element.querySelector('[data-slot="attachment-actions"]');
      const section = element.closest('section');
      if (!(name instanceof HTMLElement) || !(actions instanceof HTMLElement) || !section) {
        return null;
      }
      const nameStyle = getComputedStyle(name);
      const rowStyle = getComputedStyle(element);
      const nameBox = name.getBoundingClientRect();
      const actionsBox = actions.getBoundingClientRect();
      const rowBox = element.getBoundingClientRect();
      const node = name.firstChild;
      const lines: number[] = [];
      if (node && node.nodeType === Node.TEXT_NODE && node.textContent) {
        const range = document.createRange();
        const text = node.textContent;
        let currentTop: number | null = null;
        let count = 0;
        for (let index = 0; index < text.length; index += 1) {
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const rect = range.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          if (currentTop === null || Math.abs(rect.top - currentTop) > 2) {
            if (count > 0) lines.push(count);
            currentTop = rect.top;
            count = 1;
          } else {
            count += 1;
          }
        }
        if (count > 0) lines.push(count);
      }
      const buttons = [...actions.querySelectorAll('a, button')].map((control) => {
        const box = control.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          inside: box.left >= rowBox.left - 1 && box.right <= rowBox.right + 1,
        };
      });
      return {
        wordBreak: nameStyle.wordBreak,
        overflowWrap: nameStyle.overflowWrap,
        rowOverflow: rowStyle.overflowX,
        nameWidth: nameBox.width,
        rowWidth: rowBox.width,
        separated:
          nameBox.right <= actionsBox.left + 1 ||
          actionsBox.right <= nameBox.left + 1 ||
          nameBox.bottom <= actionsBox.top + 1 ||
          actionsBox.bottom <= nameBox.top + 1,
        lines,
        buttons,
        sectionOverflow: section.scrollWidth > section.clientWidth + 1,
        pageOverflow: (() => {
          const scale = Number.parseFloat(document.documentElement.style.zoom || '1') || 1;
          return (
            document.documentElement.scrollWidth > document.documentElement.clientWidth * scale + 2
          );
        })(),
      };
    });
    expect(layout, label).not.toBeNull();
    if (!layout) continue;
    expect(layout.wordBreak, label).not.toBe('break-all');
    expect(layout.overflowWrap, label).toBe('break-word');
    expect(layout.nameWidth, label).toBeGreaterThan(140);
    expect(layout.separated, label).toBe(true);
    expect(layout.rowOverflow, label).not.toBe('auto');
    expect(layout.rowOverflow, label).not.toBe('scroll');
    expect(layout.sectionOverflow, label).toBe(false);
    expect(layout.pageOverflow, label).toBe(false);
    const wrapped = layout.lines.length > 1 ? layout.lines.slice(0, -1) : layout.lines;
    expect(Math.min(...wrapped), label).toBeGreaterThanOrEqual(8);
    expect(layout.buttons.length, label).toBeGreaterThanOrEqual(2);
    for (const button of layout.buttons) {
      expect(button.height, label).toBeGreaterThanOrEqual(44);
      expect(button.inside, label).toBe(true);
    }
    await page.evaluate(() => {
      document.querySelectorAll('[data-sonner-toast]').forEach((node) => node.remove());
    });
    await row.getByRole('button', { name: 'Открыть' }).click({ trial: true });
    await row.getByRole('link', { name: 'Скачать' }).click({ trial: true });
    await row.getByRole('button', { name: 'Архивировать' }).click({ trial: true });
    await row.getByRole('button', { name: 'Открыть' }).focus();
    const focusInside = await row.evaluate((element) => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !element.contains(active)) return false;
      const box = active.getBoundingClientRect();
      const rowBox = element.getBoundingClientRect();
      return box.top >= rowBox.top - 8 && box.bottom <= rowBox.bottom + 8;
    });
    expect(focusInside, label).toBe(true);
    await expect(page.getByRole('button', { name: 'Добавить файлы' })).toBeVisible();
    if (viewport.shot) {
      await row.screenshot({
        path: `apps/web/e2e/artifacts/attachment-layout-${viewport.shot}.png`,
      });
    }
  }

  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
  });
  expect(applicationErrors(errors)).toEqual([]);
});
