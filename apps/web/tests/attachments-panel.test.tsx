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
  });
});
