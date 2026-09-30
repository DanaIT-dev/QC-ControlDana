import type { ComponentHealth, SystemStatusResponse } from '@sgr-registry/contracts';
import {
  canManageSystemSettings,
  canViewSystemSettings,
  satisfiesCapability,
} from '@sgr-registry/domain';
import { CheckCircle2, Database, Server, Wifi } from 'lucide-react';
import { AppShell } from '../app-shell';
import { ForbiddenState } from '@/components/forbidden-state';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchSystemStatus, requireBusinessUser } from '../../lib/server-auth';
import { NotificationSettingsForm } from './notification-settings-form';

export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<ComponentHealth, string> = {
  up: 'Работает',
  degraded: 'Есть проблемы',
  down: 'Недоступен',
  checking: 'Проверяется',
};

export default async function SystemStatusPage() {
  const user = await requireBusinessUser();
  if (!satisfiesCapability(user.role, 'VIEW_SYSTEM_STATUS')) {
    return (
      <AppShell user={user}>
        <ForbiddenState description="Эта страница доступна только администратору." />
      </AppShell>
    );
  }

  const status = await fetchSystemStatus();
  const data = status.data as SystemStatusResponse | null;
  const overview = data?.overview ?? [];
  const checkedAt = overview[0]?.checkedAt ?? data?.timestamp ?? null;
  const canViewSettings = canViewSystemSettings(user.role);
  const canManageSettings = canManageSystemSettings(user.role);

  return (
    <AppShell user={user}>
      <PageHeader
        title="Техническое состояние системы"
        description="Диагностика инфраструктуры. Управление сервисами недоступно."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {overview.length > 0
          ? overview.map((item) => (
              <OverviewCard
                key={item.component}
                title={item.component}
                status={item.status}
                message={item.message}
              />
            ))
          : (
              [
                ['Web', data ? 'up' : 'checking'],
                ['API', status.status === 200 ? 'up' : 'down'],
                ['PostgreSQL', data?.components.postgres.status === 'up' ? 'up' : 'down'],
                ['Redis', data?.components.redis.status === 'up' ? 'up' : 'down'],
                ['Хранилище', data?.components.objectStorage.status === 'up' ? 'up' : 'down'],
                ['ClamAV', data?.components.clamav.status === 'up' ? 'up' : 'down'],
              ] as const
            ).map(([title, state]) => <OverviewCard key={title} title={title} status={state} />)}
      </div>
      {checkedAt ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Время последней проверки: {formatCheckedAt(checkedAt)}
        </p>
      ) : null}
      {canViewSettings ? (
        <Card className="mt-4 shadow-none">
          <CardHeader>
            <CardTitle className="text-sm">Настройки уведомлений</CardTitle>
          </CardHeader>
          <CardContent>
            <NotificationSettingsForm csrfToken={user.csrfToken} readOnly={!canManageSettings} />
          </CardContent>
        </Card>
      ) : null}
      {data?.notifications ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <OverviewCard
            title="Исходящие уведомления"
            status={data.notifications.outboxPending > 0 ? 'degraded' : 'up'}
            message={`В очереди: ${data.notifications.outboxPending}`}
          />
          <OverviewCard
            title="Доставка email"
            status={
              data.notifications.emailFailed > 0 || data.notifications.emailDead > 0
                ? 'degraded'
                : 'up'
            }
            message={`Ожидают: ${data.notifications.emailQueued}, ошибки: ${data.notifications.emailFailed}, отложены: ${data.notifications.emailDead}`}
          />
          <OverviewCard
            title="Проверка сроков"
            status={data.notifications.lastSlaRunAt ? 'up' : 'checking'}
            message={
              data.notifications.lastSlaRunAt
                ? `Последний запуск: ${formatCheckedAt(data.notifications.lastSlaRunAt)}`
                : 'Запуск ещё не выполнялся'
            }
          />
        </div>
      ) : null}
    </AppShell>
  );
}

function OverviewCard({
  title,
  status,
  message,
}: {
  title: string;
  status: ComponentHealth;
  message?: string;
}) {
  const ok = status === 'up';
  const warn = status === 'degraded' || status === 'checking';
  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {title === 'PostgreSQL' ? (
          <Database className={iconClass(ok, warn)} />
        ) : title === 'Redis' ? (
          <Wifi className={iconClass(ok, warn)} />
        ) : (
          <Server className={iconClass(ok, warn)} />
        )}
      </CardHeader>
      <CardContent className="grid gap-1">
        <Badge
          variant={ok ? 'success' : warn ? 'secondary' : 'error'}
          className={ok ? 'badge--ok' : warn ? undefined : 'badge--bad'}
        >
          {ok ? <CheckCircle2 className="size-3" aria-hidden /> : null}
          {STATUS_LABELS[status]}
        </Badge>
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      </CardContent>
    </Card>
  );
}

function iconClass(ok: boolean, warn: boolean): string {
  if (ok) {
    return 'size-4 text-success-foreground';
  }
  if (warn) {
    return 'size-4 text-muted-foreground';
  }
  return 'size-4 text-error-foreground';
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('ru-BY', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}
