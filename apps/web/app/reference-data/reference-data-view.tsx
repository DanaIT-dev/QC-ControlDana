'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, commandFetch } from '../../lib/command-api';

const TABS = [
  { id: 'property-objects', label: 'Объекты' },
  { id: 'organizations', label: 'Организации' },
  { id: 'work-types', label: 'Виды работ' },
  { id: 'defect-types', label: 'Виды дефектов' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function ReferenceDataView({ csrfToken }: { csrfToken: string }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabId>('property-objects');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [toast, setToast] = useState<string | null>(null);
  const listQuery = useQuery({
    queryKey: ['reference', tab, search, status],
    queryFn: async () => {
      const params = new URLSearchParams({ status });
      if (search.trim().length >= 2) {
        params.set('search', search.trim());
      }
      const response = await fetch(`/api/reference-data/${tab}?${params.toString()}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('list');
      }
      return (await response.json()) as { items: Array<Record<string, unknown>> };
    },
  });

  async function mutate(path: string, method: 'POST' | 'PATCH', body: unknown) {
    try {
      await commandFetch(path, { method, csrfToken, body });
      setToast('Справочник обновлён');
      await queryClient.invalidateQueries({ queryKey: ['reference'] });
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : 'Ошибка');
    }
  }

  return (
    <section className="panel">
      <h1>Справочники</h1>
      <div className="toolbar" role="tablist" aria-label="Справочники">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'primary-button' : 'ghost-button'}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <input
          aria-label="Поиск справочника"
          placeholder="Поиск"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Статус"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="ALL">Все</option>
          <option value="ACTIVE">Активные</option>
          <option value="ARCHIVED">Архивные</option>
        </select>
        <CreateReference
          tab={tab}
          onCreate={(body) => mutate(`/api/reference-data/${tab}`, 'POST', body)}
        />
      </div>
      {listQuery.isLoading ? <p>Загрузка…</p> : null}
      <ul className="timeline">
        {(listQuery.data?.items ?? []).map((item) => {
          const id = String(item.id);
          const version = Number(item.version);
          const active = Boolean(item.active);
          const title = String(item.name ?? item.officialName ?? item.code);
          return (
            <li key={id} className="timeline__item">
              <strong>{title}</strong>
              <p>{active ? 'Активно' : 'Архив'}</p>
              <div className="action-row">
                {active ? (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      mutate(`/api/reference-data/${tab}/${id}/archive`, 'POST', {
                        expectedVersion: version,
                      })
                    }
                  >
                    Архивировать
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      mutate(`/api/reference-data/${tab}/${id}/restore`, 'POST', {
                        expectedVersion: version,
                      })
                    }
                  >
                    Восстановить
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {toast ? (
        <p className="toast" role="status" aria-live="polite">
          {toast}
        </p>
      ) : null}
    </section>
  );
}

function CreateReference({ tab, onCreate }: { tab: TabId; onCreate: (body: unknown) => void }) {
  if (tab === 'property-objects') {
    return (
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          onCreate({ name: form.get('name'), address: form.get('address') });
          event.currentTarget.reset();
        }}
      >
        <input name="name" aria-label="Название объекта" placeholder="Название" required />
        <input name="address" aria-label="Адрес объекта" placeholder="Адрес" required />
        <button type="submit" className="primary-button">
          Создать
        </button>
      </form>
    );
  }
  if (tab === 'organizations') {
    return (
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          onCreate({
            officialName: form.get('officialName'),
            postalAddress: form.get('postalAddress'),
            email: form.get('email'),
            phone: form.get('phone'),
            contactPerson: form.get('contactPerson'),
            roles: ['LIABLE_CONTRACTOR'],
          });
          event.currentTarget.reset();
        }}
      >
        <input
          name="officialName"
          aria-label="Название организации"
          placeholder="Название"
          required
        />
        <input name="postalAddress" aria-label="Адрес организации" placeholder="Адрес" required />
        <input
          name="email"
          type="email"
          aria-label="Почта организации"
          placeholder="email"
          required
        />
        <input name="phone" aria-label="Телефон организации" placeholder="телефон" required />
        <input name="contactPerson" aria-label="Контактное лицо" placeholder="контакт" required />
        <button type="submit" className="primary-button">
          Создать
        </button>
      </form>
    );
  }
  return (
    <form
      className="toolbar"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        onCreate({ code: form.get('code'), name: form.get('name') });
        event.currentTarget.reset();
      }}
    >
      <input name="code" aria-label="Код" placeholder="Код" required />
      <input name="name" aria-label="Название" placeholder="Название" required />
      <button type="submit" className="primary-button">
        Создать
      </button>
    </form>
  );
}
