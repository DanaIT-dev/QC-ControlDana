import type { ReadyResponse } from '@sgr-registry/contracts';
import { redirect } from 'next/navigation';
import { AppShell } from '../app-shell';
import { fetchCurrentUser, fetchSystemStatus } from '../../lib/server-auth';

export const dynamic = 'force-dynamic';

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`badge ${ok ? 'badge--ok' : 'badge--bad'}`}>{label}</span>;
}

export default async function SystemStatusPage() {
  const user = await fetchCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (user.role !== 'ADMIN') {
    return (
      <AppShell user={user}>
        <section className="panel">
          <h2>Недостаточно прав</h2>
          <p className="lead">Эта страница доступна только администратору.</p>
          <a className="text-link" href="/registry">
            Вернуться в реестр
          </a>
        </section>
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
      <section className="panel">
        <h2>Техническое состояние системы</h2>
        <p className="lead">Диагностика инфраструктуры для администратора.</p>
        <div className="status-list">
          <div className="status-row">
            <span>Готовность API</span>
            <Badge ok={Boolean(systemReady)} label={systemReady ? 'готова' : 'не готова'} />
          </div>
          <div className="status-row">
            <span>PostgreSQL</span>
            <Badge ok={Boolean(postgresOk)} label={postgresOk ? 'доступна' : 'недоступна'} />
          </div>
          <div className="status-row">
            <span>Redis</span>
            <Badge ok={Boolean(redisOk)} label={redisOk ? 'доступен' : 'недоступен'} />
          </div>
        </div>
        {data?.timestamp ? (
          <p className="meta">Отметка времени готовности: {data.timestamp}</p>
        ) : null}
        <a className="text-link" href="/registry">
          Вернуться в реестр
        </a>
      </section>
    </AppShell>
  );
}
