'use client';

import type { UserRole } from '@sgr-registry/contracts';
import { postLoginPath } from '@sgr-registry/domain';
import { type FormEvent, useState } from 'react';
import { PersonNameFields } from '@/components/person-name-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, commandFetch } from '../../lib/command-api';

export function CompleteProfileForm({
  csrfToken,
  role,
  lastName: initialLastName,
  firstName: initialFirstName,
  middleName: initialMiddleName,
}: {
  csrfToken: string;
  role: UserRole;
  lastName: string;
  firstName: string;
  middleName: string;
}) {
  const [lastName, setLastName] = useState(initialLastName);
  const [firstName, setFirstName] = useState(initialFirstName);
  const [middleName, setMiddleName] = useState(initialMiddleName);
  const [phone, setPhone] = useState('');
  const [birthDate, setBirthDate] = useState('');
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
      await commandFetch('/api/users/me/complete-profile', {
        method: 'POST',
        csrfToken,
        body: {
          lastName,
          firstName,
          middleName: middleName.trim() ? middleName : null,
          phone,
          birthDate,
        },
      });
      window.location.assign(postLoginPath(role));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось сохранить карточку');
      setPending(false);
    }
  }

  return (
    <div className="flex justify-center px-0 py-4">
      <Card className="w-full max-w-xl shadow-none">
        <CardHeader>
          <CardTitle className="text-2xl font-semibold">Карточка сотрудника</CardTitle>
          <CardDescription>
            После смены временного пароля заполните свои данные. Дату приёма и дату окончания
            контракта укажет руководитель.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={(event) => void onSubmit(event)}>
            <PersonNameFields
              idPrefix="card"
              lastName={lastName}
              firstName={firstName}
              middleName={middleName}
              onLastNameChange={setLastName}
              onFirstNameChange={setFirstName}
              onMiddleNameChange={setMiddleName}
              disabled={pending}
            />
            <div className="grid gap-1.5">
              <Label htmlFor="card-phone">Номер телефона</Label>
              <Input
                id="card-phone"
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                required
                autoComplete="tel"
                disabled={pending}
                className="min-h-11"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="card-birth-date">Дата рождения</Label>
              <Input
                id="card-birth-date"
                type="date"
                value={birthDate}
                onChange={(event) => setBirthDate(event.target.value)}
                required
                disabled={pending}
                className="min-h-11"
              />
            </div>
            {error ? (
              <Alert variant="destructive" className="form-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? 'Сохранение…' : 'Сохранить карточку'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
