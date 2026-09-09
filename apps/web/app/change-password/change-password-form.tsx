'use client';

import { isPasswordPolicySatisfied, PASSWORD_POLICY_HINT } from '@sgr-registry/domain';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, commandFetch } from '../../lib/command-api';

export function ChangePasswordForm({
  csrfToken,
  email,
  fullName,
  nextPath = '/registry',
}: {
  csrfToken: string;
  email: string;
  fullName: string;
  nextPath?: string;
}) {
  const currentId = useId();
  const nextId = useId();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const policyOk = isPasswordPolicySatisfied(newPassword, { email, fullName });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    void submitChange();
  }

  async function submitChange() {
    setPending(true);
    setError(null);
    try {
      await commandFetch('/api/auth/change-password', {
        method: 'POST',
        csrfToken,
        body: { currentPassword, newPassword },
      });
      setSuccess(true);
      toast.success('Пароль обновлён');
      window.location.assign(nextPath);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сменить пароль');
      setPending(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={onSubmit} noValidate method="post">
      <div className="grid gap-1.5">
        <Label htmlFor={currentId}>Текущий пароль</Label>
        <div className="flex items-center gap-2">
          <Input
            id={currentId}
            type={showCurrent ? 'text' : 'password'}
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={showCurrent ? 'Скрыть текущий ввод' : 'Показать текущий ввод'}
            onClick={() => setShowCurrent((value) => !value)}
          >
            {showCurrent ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={nextId}>Новый пароль</Label>
        <div className="flex items-center gap-2">
          <Input
            id={nextId}
            type={showNext ? 'text' : 'password'}
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={showNext ? 'Скрыть новый ввод' : 'Показать новый ввод'}
            onClick={() => setShowNext((value) => !value)}
          >
            {showNext ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </div>
      </div>
      <p className="text-[13px] text-muted-foreground">{PASSWORD_POLICY_HINT}</p>
      <p
        className={`text-[13px] ${policyOk ? 'text-success-foreground' : 'text-muted-foreground'}`}
      >
        {policyOk ? 'Требования выполнены' : 'Пароль пока не соответствует политике'}
      </p>
      {error ? (
        <Alert variant="destructive" className="form-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {success ? (
        <Alert>
          <AlertDescription>Пароль обновлён, выполняется переход в реестр.</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Сохранение…' : 'Сменить пароль'}
      </Button>
    </form>
  );
}

export function ChangePasswordCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center px-0 py-4">
      <Card className="w-full max-w-110 shadow-none">
        <CardHeader>
          <CardTitle className="text-2xl font-semibold">Смена временного пароля</CardTitle>
          <CardDescription>Перед работой в реестре задайте новый пароль.</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}
