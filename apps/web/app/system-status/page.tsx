import type { ReadyResponse } from '@sgr-registry/contracts';
import { redirect } from 'next/navigation';
import { CheckCircle2, Database, Server, Wifi } from 'lucide-react';
import { AppShell } from '../app-shell';
import { ForbiddenState } from '@/components/forbidden-state';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { fetchCurrentUser, fetchSystemStatus } from '../../lib/server-auth';

export const dynamic = 'force-dynamic';

export default async function SystemStatusPage() {
  const user = await fetchCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (user.role !== 'ADMIN') {
    return (
      <AppShell user={user}>
        <ForbiddenState description="Эта страница доступна только администратору." />
      </AppShell>
    );
  }

  const status = await fetchSystemStatus();
  const data = status.data as ReadyResponse | null;
  const postgresOk = data?.components.postgres.status === 'up';
  const redisOk = data?.components.redis.status === 'up';
  const systemReady = status.status === 200 && data?.status === 'ready';

  return (
    <AppShell user={user}>
      <PageHeader
        title="Техническое состояние системы"
        description="Диагностика инфраструктуры для администратора."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <HealthCard
          title="Готовность API"
          ok={Boolean(systemReady)}
          okLabel="готова"
          badLabel="не готова"
          icon={Server}
        />
        <HealthCard
          title="PostgreSQL"
          ok={Boolean(postgresOk)}
          okLabel="доступна"
          badLabel="недоступна"
          icon={Database}
        />
        <HealthCard
          title="Redis"
          ok={Boolean(redisOk)}
          okLabel="доступен"
          badLabel="недоступен"
          icon={Wifi}
        />
        <HealthCard
          title="MinIO"
          ok={data?.components.minio.status === 'up'}
          okLabel="доступно"
          badLabel="недоступно"
          icon={Server}
        />
        <HealthCard
          title="ClamAV"
          ok={data?.components.clamav.status === 'up'}
          okLabel="доступен"
          badLabel="недоступен"
          icon={Database}
        />
      </div>
      {data?.timestamp ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Отметка времени готовности: {data.timestamp}
        </p>
      ) : null}
      <Collapsible className="mt-4">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="link" className="h-auto px-0 text-sm font-medium">
            Технические сведения
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Card className="mt-3 shadow-none">
            <CardHeader>
              <CardTitle className="text-sm">Компоненты</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <p>Статус: {data?.status ?? '—'}</p>
              <p>PostgreSQL: {data?.components.postgres.status ?? '—'}</p>
              <p>Redis: {data?.components.redis.status ?? '—'}</p>
              <p>MinIO: {data?.components.minio.status ?? '—'}</p>
              <p>ClamAV: {data?.components.clamav.status ?? '—'}</p>
            </CardContent>
          </Card>
        </CollapsibleContent>
      </Collapsible>
    </AppShell>
  );
}

function HealthCard({
  title,
  ok,
  okLabel,
  badLabel,
  icon: Icon,
}: {
  title: string;
  ok: boolean;
  okLabel: string;
  badLabel: string;
  icon: typeof Server;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className={ok ? 'size-4 text-success-foreground' : 'size-4 text-error-foreground'} />
      </CardHeader>
      <CardContent>
        <Badge variant={ok ? 'success' : 'error'} className={ok ? 'badge--ok' : 'badge--bad'}>
          {ok ? <CheckCircle2 className="size-3" aria-hidden /> : null}
          {ok ? okLabel : badLabel}
        </Badge>
      </CardContent>
    </Card>
  );
}
