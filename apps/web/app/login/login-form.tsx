'use client';

import {
  AUTH_LOGIN_FAILED_MESSAGE,
  AUTH_RATE_LIMITED_MESSAGE,
  postLoginPath,
} from '@sgr-registry/domain';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function LoginForm() {
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    void submitLogin();
  }

  async function submitLogin() {
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
        setPending(false);
        return;
      }
      if (!response.ok) {
        setPassword('');
        setError(AUTH_LOGIN_FAILED_MESSAGE);
        setPending(false);
        return;
      }
      const profile = (await response.json()) as {
        mustChangePassword?: boolean;
        mustCompleteProfile?: boolean;
        role?: Parameters<typeof postLoginPath>[0];
      };
      const nextPath = profile.role
        ? postLoginPath(
            profile.role,
            Boolean(profile.mustChangePassword),
            Boolean(profile.mustCompleteProfile),
          )
        : '/';
      window.location.assign(nextPath);
    } catch {
      setPassword('');
      setError(AUTH_LOGIN_FAILED_MESSAGE);
      setPending(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={onSubmit} noValidate method="post">
      <div className="grid gap-1.5">
        <Label htmlFor={emailId}>Электронная почта</Label>
        <Input
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
      <div className="grid gap-1.5">
        <Label htmlFor={passwordId}>Пароль</Label>
        <div className="flex items-center gap-2">
          <Input
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
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setShowPassword((value) => !value)}
            disabled={pending}
            aria-label={showPassword ? 'Скрыть ввод' : 'Показать ввод'}
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </div>
      </div>
      {error ? (
        <Alert id={errorId} variant="destructive" className="form-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending || !ready} className="w-full">
        {pending ? 'Вход…' : 'Войти'}
      </Button>
    </form>
  );
}
