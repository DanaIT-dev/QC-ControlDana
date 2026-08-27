'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useId, useState } from 'react';
import { ApiError, commandFetch } from '../../lib/command-api';

export function ChangePasswordForm({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const currentId = useId();
  const nextId = useId();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await commandFetch('/api/auth/change-password', {
        method: 'POST',
        csrfToken,
        body: { currentPassword, newPassword },
      });
      router.replace('/registry');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сменить пароль');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor={currentId}>Текущий пароль</label>
        <input
          id={currentId}
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor={nextId}>Новый пароль</label>
        <input
          id={nextId}
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
        />
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="primary-button" disabled={pending}>
        {pending ? 'Сохранение…' : 'Сменить пароль'}
      </button>
    </form>
  );
}
