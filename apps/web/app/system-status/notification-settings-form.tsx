'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchNotificationSettings, patchNotificationSettings } from '@/lib/notifications-api';
import { queryKeys } from '@/lib/query-keys';

export function NotificationSettingsForm({ csrfToken }: { csrfToken: string }) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: queryKeys.notificationSettings,
    queryFn: fetchNotificationSettings,
  });
  const [warningDays, setWarningDays] = useState<string>('');
  const [escalation, setEscalation] = useState<string>('');
  const [time, setTime] = useState<string>('');
  const [emailEnabled, setEmailEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      if (!settings.data) {
        throw new Error('no settings');
      }
      return patchNotificationSettings(csrfToken, {
        expectedVersion: settings.data.version,
        deadlineWarningDays: warningDays ? Number(warningDays) : settings.data.deadlineWarningDays,
        escalationDays: escalation
          ? escalation.split(',').map((item) => Number(item.trim()))
          : settings.data.escalationDays,
        dailyEvaluationTime: time || settings.data.dailyEvaluationTime,
        emailEnabled: emailEnabled ?? settings.data.emailEnabled,
      });
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.notificationSettings });
    },
    onError: (err: Error & { status?: number }) => {
      setError(
        err.status === 409 ? 'Настройки изменены другим пользователем' : 'Не удалось сохранить',
      );
    },
  });

  if (settings.isLoading) {
    return <p className="text-sm text-muted-foreground">Загрузка настроек…</p>;
  }
  if (!settings.data) {
    return <p className="text-sm text-error-foreground">Не удалось загрузить настройки</p>;
  }
  const current = settings.data;
  return (
    <form
      className="grid max-w-xl gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="warning-days">Дней до предупреждения</Label>
        <Input
          id="warning-days"
          className="min-h-11"
          defaultValue={current.deadlineWarningDays}
          onChange={(event) => setWarningDays(event.target.value)}
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="escalation-days">Пороги эскалации (дни через запятую)</Label>
        <Input
          id="escalation-days"
          className="min-h-11"
          defaultValue={current.escalationDays.join(', ')}
          onChange={(event) => setEscalation(event.target.value)}
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="eval-time">Ежедневная проверка (Europe/Minsk)</Label>
        <Input
          id="eval-time"
          className="min-h-11"
          defaultValue={current.dailyEvaluationTime}
          onChange={(event) => setTime(event.target.value)}
        />
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          defaultChecked={current.emailEnabled}
          onChange={(event) => setEmailEnabled(event.target.checked)}
        />
        Email-уведомления включены
      </label>
      <p className="text-xs text-muted-foreground">
        SMTP-пароль не отображается и не доступен через API.
      </p>
      {error ? <p className="text-sm text-error-foreground">{error}</p> : null}
      <Button type="submit" className="min-h-11 w-fit" disabled={save.isPending}>
        Сохранить настройки
      </Button>
    </form>
  );
}
