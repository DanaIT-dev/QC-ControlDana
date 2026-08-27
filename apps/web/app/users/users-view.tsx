'use client';

import { USER_ROLES, USER_STATUSES } from '@sgr-registry/contracts';
import { roleLabel } from '@sgr-registry/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, commandFetch } from '../../lib/command-api';

interface UserRow {
  id: string;
  fullName: string;
  email: string;
  role: (typeof USER_ROLES)[number];
  roleLabel: string;
  status: (typeof USER_STATUSES)[number];
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  version: number;
}

export function UsersView({
  csrfToken,
  currentUserId,
}: {
  csrfToken: string;
  currentUserId: string;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const usersQuery = useQuery({
    queryKey: ['users', search, role, status],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search.trim().length >= 2) {
        params.set('search', search.trim());
      }
      if (role) {
        params.set('role', role);
      }
      if (status) {
        params.set('status', status);
      }
      const response = await fetch(`/api/users?${params.toString()}`, { credentials: 'include' });
      if (!response.ok) {
        throw new Error('list');
      }
      return (await response.json()) as { items: UserRow[] };
    },
  });

  async function mutate(path: string, method: 'POST' | 'PATCH', body: unknown) {
    try {
      const result = await commandFetch<{ temporaryPassword?: string }>(path, {
        method,
        csrfToken,
        body,
      });
      if (result.temporaryPassword) {
        setTemporaryPassword(result.temporaryPassword);
      }
      setToast('Изменения сохранены');
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : 'Ошибка');
    }
  }

  return (
    <section className="panel">
      <h1>Пользователи</h1>
      <div className="toolbar">
        <input
          aria-label="Поиск пользователей"
          placeholder="Поиск"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select aria-label="Роль" value={role} onChange={(event) => setRole(event.target.value)}>
          <option value="">Все роли</option>
          {USER_ROLES.map((item) => (
            <option key={item} value={item}>
              {roleLabel(item)}
            </option>
          ))}
        </select>
        <select
          aria-label="Статус"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">Все статусы</option>
          <option value="ACTIVE">Активные</option>
          <option value="ARCHIVED">Архивные</option>
        </select>
        <button type="button" className="primary-button" onClick={() => setCreateOpen(true)}>
          Создать пользователя
        </button>
      </div>
      {temporaryPassword ? (
        <div className="panel">
          <p>Временный пароль показывается один раз:</p>
          <p className="temp-password">{temporaryPassword}</p>
          <button
            type="button"
            className="ghost-button"
            onClick={() => navigator.clipboard.writeText(temporaryPassword)}
          >
            Скопировать
          </button>
          <p className="lead">Повторно показать пароль нельзя.</p>
        </div>
      ) : null}
      {usersQuery.isLoading ? <p>Загрузка…</p> : null}
      <div className="desktop-only">
        <table className="data-table">
          <thead>
            <tr>
              <th>ФИО</th>
              <th>Почта</th>
              <th>Роль</th>
              <th>Статус</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {(usersQuery.data?.items ?? []).map((item) => (
              <tr key={item.id}>
                <td>{item.fullName}</td>
                <td>{item.email}</td>
                <td>{item.roleLabel}</td>
                <td>{item.status === 'ACTIVE' ? 'Активен' : 'Архив'}</td>
                <td className="action-row">
                  <UserActions user={item} currentUserId={currentUserId} onMutate={mutate} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mobile-only">
        {(usersQuery.data?.items ?? []).map((item) => (
          <article className="defect-card" key={item.id}>
            <h2>{item.fullName}</h2>
            <p>{item.email}</p>
            <p>
              {item.roleLabel} · {item.status === 'ACTIVE' ? 'Активен' : 'Архив'}
            </p>
            <UserActions user={item} currentUserId={currentUserId} onMutate={mutate} />
          </article>
        ))}
      </div>
      {createOpen ? (
        <CreateUserDialog
          onClose={() => setCreateOpen(false)}
          onCreate={async (body) => {
            await mutate('/api/users', 'POST', body);
            setCreateOpen(false);
          }}
        />
      ) : null}
      {toast ? (
        <p className="toast" role="status" aria-live="polite">
          {toast}
        </p>
      ) : null}
    </section>
  );
}

function UserActions({
  user,
  currentUserId,
  onMutate,
}: {
  user: UserRow;
  currentUserId: string;
  onMutate: (path: string, method: 'POST' | 'PATCH', body: unknown) => Promise<void>;
}) {
  const nextRole = user.role === 'SGR_MANAGER' ? 'ADMIN' : 'SGR_MANAGER';
  return (
    <div className="action-row">
      <button
        type="button"
        className="ghost-button"
        onClick={() =>
          onMutate(`/api/users/${user.id}`, 'PATCH', {
            expectedVersion: user.version,
            role: nextRole,
          })
        }
      >
        Изменить роль
      </button>
      {user.status === 'ACTIVE' && user.id !== currentUserId ? (
        <button
          type="button"
          className="ghost-button"
          onClick={() =>
            onMutate(`/api/users/${user.id}/archive`, 'POST', { expectedVersion: user.version })
          }
        >
          Архивировать
        </button>
      ) : null}
      {user.status === 'ARCHIVED' ? (
        <button
          type="button"
          className="ghost-button"
          onClick={() =>
            onMutate(`/api/users/${user.id}/restore`, 'POST', { expectedVersion: user.version })
          }
        >
          Восстановить
        </button>
      ) : null}
      <button
        type="button"
        className="ghost-button"
        onClick={() =>
          onMutate(`/api/users/${user.id}/reset-password`, 'POST', {
            expectedVersion: user.version,
          })
        }
      >
        Сбросить пароль
      </button>
    </div>
  );
}

function CreateUserDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (body: unknown) => Promise<void>;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof USER_ROLES)[number]>('RESPONSIBLE_ENGINEER');
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="dialog form-grid"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-user-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate({ fullName, email, role });
        }}
      >
        <h2 id="create-user-title">Новый пользователь</h2>
        <div className="field">
          <label htmlFor="new-user-name">ФИО</label>
          <input
            id="new-user-name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="new-user-email">Электронная почта</label>
          <input
            id="new-user-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="new-user-role">Роль</label>
          <select
            id="new-user-role"
            value={role}
            onChange={(event) => setRole(event.target.value as (typeof USER_ROLES)[number])}
          >
            {USER_ROLES.map((item) => (
              <option key={item} value={item}>
                {roleLabel(item)}
              </option>
            ))}
          </select>
        </div>
        <div className="action-row">
          <button type="submit" className="primary-button">
            Создать
          </button>
          <button type="button" className="ghost-button" onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </div>
  );
}
