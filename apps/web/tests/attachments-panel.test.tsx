import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentsPanel } from '../components/attachments-panel';

const limits = {
  maxBytes: 10 * 1024 * 1024,
  maxPerOwner: 20,
  allowedMimeTypes: ['application/pdf'],
  allowedExtensions: ['.pdf'],
};

const FILENAMES = [
  'акт.pdf',
  '30.8 (15.4) – дефектный акт (С-1) от 05.08.2026 (6 дефектных отделки).pdf',
  'Дефектный акт по объекту 30.8 «Майами» от 25.02.2022.pdf',
  'ОченьДлинноеИмяФайлаБезПробеловКотороеНеДолжноВыходитьЗаГраницыКарточкиДокумента.pdf',
  'акт-с-кириллицей-и-дефисами-финальная-версия-№2.pdf',
] as const;

function attachmentItem(
  overrides: Record<string, unknown> & { safeDisplayName?: string; id?: string } = {},
) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    ownerType: 'ACT',
    ownerId: '22222222-2222-4222-8222-222222222222',
    category: 'ACT_DOCUMENT',
    safeDisplayName: 'акт.pdf',
    sizeBytes: '1992294',
    detectedMimeType: 'application/pdf',
    status: 'READY',
    uploadedBy: {
      id: '33333333-3333-4333-8333-333333333333',
      fullName: 'Родкевич А.С.',
    },
    createdAt: '2026-10-28T05:41:00.000Z',
    scannedAt: '2026-10-28T05:42:00.000Z',
    version: 1,
    canPreview: true,
    canDownload: true,
    canArchive: true,
    ...overrides,
  };
}

function listResponse(items: ReturnType<typeof attachmentItem>[]) {
  return {
    items,
    activeCount: items.length,
    limits,
    allowedMimeTypes: ['application/pdf'],
    capabilities: { canUpload: true, canArchive: true, canDownload: true },
  };
}

function mockList(items: ReturnType<typeof attachmentItem>[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(listResponse(items)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

function renderPanel(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('act attachments panel', () => {
  it('shows a calm empty state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              items: [],
              activeCount: 0,
              limits,
              allowedMimeTypes: ['application/pdf'],
              capabilities: { canUpload: true, canArchive: false, canDownload: true },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    renderPanel(
      <AttachmentsPanel
        title="Вложения акта"
        listPath="/api/acts/act/attachments"
        uploadPath="/api/acts/act/attachments"
        categories={['ACT_DOCUMENT']}
        canUpload
        csrfToken="csrf"
        emptyLabel="Вложения отсутствуют"
        uploadLabel="Добавить файлы"
      />,
    );
    expect(await screen.findByText('Вложения отсутствуют')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Добавить файлы' })).toBeTruthy();
  });

  it('renders a script-like filename as text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              items: [
                {
                  id: '11111111-1111-4111-8111-111111111111',
                  ownerType: 'ACT',
                  ownerId: '22222222-2222-4222-8222-222222222222',
                  category: 'ACT_DOCUMENT',
                  safeDisplayName: '<script>alert(1)<_script>.pdf',
                  sizeBytes: '1200',
                  detectedMimeType: 'application/pdf',
                  status: 'READY',
                  uploadedBy: {
                    id: '33333333-3333-4333-8333-333333333333',
                    fullName: 'Администратор',
                  },
                  createdAt: '2024-04-12T12:00:00.000Z',
                  scannedAt: '2024-04-12T12:01:00.000Z',
                  version: 1,
                  canPreview: true,
                  canDownload: true,
                  canArchive: false,
                },
              ],
              activeCount: 1,
              limits,
              allowedMimeTypes: ['application/pdf'],
              capabilities: { canUpload: true, canArchive: false, canDownload: true },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const view = renderPanel(
      <AttachmentsPanel
        title="Вложения акта"
        listPath="/api/acts/act/attachments"
        uploadPath="/api/acts/act/attachments"
        categories={['ACT_DOCUMENT']}
        canUpload={false}
        csrfToken="csrf"
      />,
    );
    expect(await screen.findByText('<script>alert(1)<_script>.pdf')).toBeTruthy();
    expect(view.container.querySelector('script')).toBeNull();
    const name = view.container.querySelector('[data-slot="attachment-name"]');
    expect(name?.className).not.toContain('break-all');
    expect(name?.getAttribute('title')).toBe('<script>alert(1)<_script>.pdf');
    expect(name?.textContent).toBe('<script>alert(1)<_script>.pdf');
  });

  it('gives the filename the available width and keeps actions separate', async () => {
    const longName = FILENAMES[1];
    mockList([attachmentItem({ safeDisplayName: longName })]);
    const view = renderPanel(
      <AttachmentsPanel
        title="Вложения акта"
        listPath="/api/acts/act/attachments"
        uploadPath="/api/acts/act/attachments"
        categories={['ACT_DOCUMENT']}
        canUpload
        csrfToken="csrf"
        uploadLabel="Добавить файлы"
      />,
    );
    const name = await screen.findByText(longName);
    expect(name.className).not.toMatch(/break-all|word-break:\s*break-all/);
    expect(name.className).toContain('overflow-wrap:break-word');
    expect(name.className).toContain('word-break:normal');
    expect(name.getAttribute('title')).toBe(longName);
    expect(name.textContent).toBe(longName);
    const info = view.container.querySelector('[data-slot="attachment-info"]');
    expect(info?.className).toContain('min-w-0');
    expect(info?.className).toContain('flex-1');
    expect(info?.className).not.toContain('w-min');
    const actions = view.container.querySelector('[data-slot="attachment-actions"]');
    expect(actions).toBeTruthy();
    expect(actions?.contains(name)).toBe(false);
    expect(name.closest('[data-slot="attachment-actions"]')).toBeNull();
    for (const label of ['Открыть', 'Скачать', 'Архивировать']) {
      const control = screen.getByRole(label === 'Скачать' ? 'link' : 'button', { name: label });
      expect(control.className).toContain('whitespace-nowrap');
      expect(control.className).toContain('focus-visible:');
    }
    expect(screen.getByRole('button', { name: 'Добавить файлы' })).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/bitrix/i);
  });

  it('shows natural filenames, metadata and statuses without a missing author', async () => {
    mockList([
      ...FILENAMES.map((safeDisplayName, index) =>
        attachmentItem({
          id: `11111111-1111-4111-8111-11111111111${index}`,
          safeDisplayName,
          uploadedBy: {
            id: '33333333-3333-4333-8333-333333333333',
            fullName:
              index === 0 ? 'Родионов Александр Сергеевич' : index === 4 ? '' : 'Родкевич А.С.',
          },
          status: ['PENDING_SCAN', 'SCANNING', 'READY', 'REJECTED', 'SCAN_FAILED'][index],
          canPreview: index === 2,
          canDownload: index === 2,
          canArchive: index === 2,
        }),
      ),
      attachmentItem({
        id: '11111111-1111-4111-8111-111111111119',
        safeDisplayName: 'без-автора.pdf',
        status: 'UPLOADING',
        uploadedBy: {
          id: '33333333-3333-4333-8333-333333333333',
          fullName: 'user@example.com',
        },
        canPreview: false,
        canDownload: false,
        canArchive: false,
      }),
    ]);
    const view = renderPanel(
      <AttachmentsPanel
        title="Вложения акта"
        listPath="/api/acts/act/attachments"
        uploadPath="/api/acts/act/attachments"
        categories={['ACT_DOCUMENT']}
        canUpload={false}
        csrfToken="csrf"
        emptyLabel="Вложения отсутствуют"
      />,
    );
    for (const filename of FILENAMES) {
      const name = await screen.findByText(filename);
      expect(name.className).not.toContain('break-all');
      expect(name.getAttribute('title')).toBe(filename);
    }
    expect(screen.getAllByText('Проверка')).toHaveLength(2);
    expect(screen.getAllByText('Готово').length).toBeGreaterThan(0);
    expect(screen.getByText('Отклонено')).toBeTruthy();
    expect(screen.getByText('Не удалось проверить')).toBeTruthy();
    expect(screen.getByText('Загрузка')).toBeTruthy();
    expect(screen.getAllByText(/PDF · /).length).toBeGreaterThan(0);
    expect(view.container.textContent).not.toMatch(/\bnull\b|\bundefined\b/);
    expect(view.container.textContent).not.toContain('@');
    const hidden = view.container.querySelectorAll('[data-slot="attachment-row"]');
    const last = hidden[hidden.length - 1];
    expect(last?.querySelector('[data-slot="attachment-actions"]')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Открыть' })).toHaveLength(1);
  });
});
