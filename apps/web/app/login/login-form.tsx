'use client';

import { AUTH_LOGIN_FAILED_MESSAGE, AUTH_RATE_LIMITED_MESSAGE } from '@sgr-registry/domain';
import { useRouter } from 'next/navigation';
import { type FormEvent, useId, useState } from 'react';

export function LoginForm() {
  const router = useRouter();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (response.status === 429) {
        setPassword('');
        setError(AUTH_RATE_LIMITED_MESSAGE);
        return;
      }
      if (!response.ok) {
        setPassword('');
        setError(AUTH_LOGIN_FAILED_MESSAGE);
        return;
      }
      router.replace('/registry');
      router.refresh();
    } catch {
      setPassword('');
      setError(AUTH_LOGIN_FAILED_MESSAGE);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="login-form" onSubmit={onSubmit} noValidate>
      <div className="field">
        <label htmlFor={emailId}>Электронная почта</label>
        <input
          id={emailId}
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          disabled={pending}
        />
      </div>
      <div className="field">
        <label htmlFor={passwordId}>Пароль</label>
        <div className="password-row">
          <input
            id={passwordId}
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            disabled={pending}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
          />
          <button
            type="button"
            className="ghost-button"
            onClick={() => setShowPassword((value) => !value)}
            disabled={pending}
          >
            {showPassword ? 'Скрыть' : 'Показать'}
          </button>
        </div>
      </div>
      {error ? (
        <p className="form-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="primary-button" disabled={pending}>
        {pending ? 'Вход…' : 'Войти'}
      </button>
    </form>
  );
}
