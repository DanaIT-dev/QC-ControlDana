'use client';

import { isPasswordPolicySatisfied, PASSWORD_MIN_LENGTH } from '@sgr-registry/domain';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, type SyntheticEvent, useId, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, commandFetch } from '../../lib/command-api';

export function ChangePasswordForm({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const currentId = useId();
  const nextId = useId();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const policyOk = isPasswordPolicySatisfied(newPassword);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
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
      setSuccess(true);
      toast.success('Пароль обновлён');
      router.replace('/registry');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сменить пароль');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={onSubmit}>
      <div className="grid gap-1.5">
        <Label htmlFor={currentId}>Текущий пароль</Label>
        <div className="flex gap-2">
          <Input
            id={currentId}
            type={showCurrent ? 'text' : 'password'}
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
          <Button
            type="button"
            variant="outline"
            aria-label={showCurrent ? 'Скрыть текущий ввод' : 'Показать текущий ввод'}
            onClick={() => setShowCurrent((value) => !value)}
          >
            {showCurrent ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={nextId}>Новый пароль</Label>
        <div className="flex gap-2">
          <Input
            id={nextId}
            type={showNext ? 'text' : 'password'}
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
          />
          <Button
            type="button"
            variant="outline"
            aria-label={showNext ? 'Скрыть новый ввод' : 'Показать новый ввод'}
            onClick={() => setShowNext((value) => !value)}
          >
            {showNext ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </div>
      </div>
      <ul className="grid gap-1 text-[13px] text-muted-foreground">
        <li>Не менее {PASSWORD_MIN_LENGTH} символов</li>
        <li>Заглавная и строчная буква</li>
        <li>Цифра и спецсимвол</li>
        <li className={policyOk ? 'text-success-foreground' : ''}>
          {policyOk ? 'Требования выполнены' : 'Пароль пока не соответствует политике'}
        </li>
      </ul>
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
      <Card className="w-full max-w-[440px] shadow-none">
        <CardHeader>
          <CardTitle className="text-2xl font-semibold">Смена временного пароля</CardTitle>
          <CardDescription>
            Перед работой в реестре задайте новый пароль по политике сложности.
          </CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}
