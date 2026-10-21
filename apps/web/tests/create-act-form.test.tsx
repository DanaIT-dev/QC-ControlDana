import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CreateActForm,
  createDraftDefect,
  INITIAL_DRAFT_DEFECT_KEY,
} from '../app/acts/new/create-act-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function isHydrationError(message: string): boolean {
  return (
    /hydrat/i.test(message) ||
    /Minified React error #418/.test(message) ||
    /did not match the client/i.test(message) ||
    /server rendered HTML/i.test(message)
  );
}

function formTree(): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return (
    <QueryClientProvider client={client}>
      <CreateActForm csrfToken="csrf-token" />
    </QueryClientProvider>
  );
}

describe('create act draft ids', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('uses a deterministic first draft key without calling randomUUID', () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID');
    const draft = createDraftDefect(INITIAL_DRAFT_DEFECT_KEY);
    expect(draft.key).toBe('draft-defect-0');
    expect(randomUUID).not.toHaveBeenCalled();
  });

  it('hydrates with matching label/input ids when randomUUID returns different values', async () => {
    let uuidSeq = 0;
    const randomUUID = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      uuidSeq += 1;
      return `aaaaaaaa-bbbb-4ccc-8ddd-${String(uuidSeq).padStart(12, '0')}`;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          propertyObjects: [],
          customers: [],
          defectTypes: [],
          responsibleEngineers: [],
          liableOrganizations: [],
        }),
      })),
    );

    const hydrationErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      hydrationErrors.push(args.map(String).join(' '));
      originalError.apply(console, args);
    };

    const html = renderToString(formTree());
    expect(html).toContain(`data-draft-key="${INITIAL_DRAFT_DEFECT_KEY}"`);
    expect(html).not.toMatch(/data-draft-key="[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(randomUUID).not.toHaveBeenCalled();

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    await act(async () => {
      hydrateRoot(container, formTree(), {
        onRecoverableError: (error) => {
          hydrationErrors.push(String(error));
        },
      });
    });

    expect(hydrationErrors.filter((message) => isHydrationError(message))).toEqual([]);
    expect(randomUUID).not.toHaveBeenCalled();

    const locationLabel = within(container).getByText('Помещение');
    const htmlFor = locationLabel.getAttribute('for');
    expect(htmlFor).toBeTruthy();
    const locationInput = container.querySelector(`#${CSS.escape(htmlFor ?? '')}`);
    expect(locationInput).toBeInstanceOf(HTMLInputElement);
    expect(locationInput).toHaveAttribute('id', htmlFor);

    const user = userEvent.setup();
    await user.click(within(container).getByRole('button', { name: 'Добавить дефект' }));

    const cards = container.querySelectorAll('[data-draft-key]');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.getAttribute('data-draft-key')).toBe(INITIAL_DRAFT_DEFECT_KEY);
    expect(cards[1]?.getAttribute('data-draft-key')).toBe('aaaaaaaa-bbbb-4ccc-8ddd-000000000001');
    expect(cards[0]?.getAttribute('data-draft-key')).not.toBe(
      cards[1]?.getAttribute('data-draft-key'),
    );
    expect(randomUUID).toHaveBeenCalledTimes(1);

    console.error = originalError;
  });

  it('submits only canonical objectId without name or address spoof fields', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/operations/lookups')) {
        return {
          ok: true,
          json: async () => ({
            propertyObjects: [
              {
                id: 'obj-a',
                name: 'ЖК «Альфа»',
                address: 'г. Минск, ул. Первая, 1',
                responsibleEngineerIds: ['eng-1'],
              },
            ],
            customers: [{ id: 'cust-1', officialName: 'Заказчик' }],
            defectTypes: [{ id: 'type-1', name: 'Течь' }],
            workTypes: [{ id: 'work-1', name: 'Окна' }],
            responsibleEngineers: [{ id: 'eng-1', fullName: 'Инженер' }],
            liableOrganizations: [{ id: 'org-1', officialName: 'Подрядчик' }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ id: 'act-created' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { findByRole, getByRole } = render(formTree());
    const user = userEvent.setup();
    await user.click(await findByRole('combobox', { name: 'Объект' }));
    await user.click(await findByRole('option', { name: /ул\. Первая, 1/ }));
    await user.click(getByRole('button', { name: 'Сохранить акт' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/acts'))).toBe(true);
    });
    const createCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/acts'));
    expect(createCall).toBeTruthy();
    const body = JSON.parse(String(createCall?.[1]?.body)) as Record<string, unknown>;
    expect(body.objectId).toBe('obj-a');
    expect(body).not.toHaveProperty('objectName');
    expect(body).not.toHaveProperty('objectAddress');
    expect(body).not.toHaveProperty('name');
    expect(body).not.toHaveProperty('address');
  });

  it('shows a clear message when defect types are empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          propertyObjects: [],
          customers: [],
          defectTypes: [],
          workTypes: [],
          responsibleEngineers: [],
          liableOrganizations: [],
        }),
      })),
    );
    const { findByText } = render(formTree());
    expect(await findByText('Виды дефектов не загружены')).toBeTruthy();
    expect(await findByText('Организации-заказчики не загружены')).toBeTruthy();
  });
});
