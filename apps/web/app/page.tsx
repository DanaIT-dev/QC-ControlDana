import type { HealthResponse, ReadyResponse } from '@sgr-registry/contracts';

export const dynamic = 'force-dynamic';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface FetchResult<T> {
  reachable: boolean;
  httpStatus: number | null;
  data: T | null;
  error: string | null;
}

async function fetchJson<T>(path: string): Promise<FetchResult<T>> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, { cache: 'no-store' });
    const data = (await response.json()) as T;
    return {
      reachable: true,
      httpStatus: response.status,
      data,
      error: null,
    };
  } catch {
    return {
      reachable: false,
      httpStatus: null,
      data: null,
      error: 'Процесс API недоступен',
    };
  }
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`badge ${ok ? 'badge--ok' : 'badge--bad'}`}>{label}</span>;
}

export default async function HomePage() {
  const [health, ready] = await Promise.all([
    fetchJson<HealthResponse>('/api/health'),
    fetchJson<ReadyResponse>('/api/ready'),
  ]);

  const apiProcessOk = health.reachable && health.data?.status === 'ok';
  const postgresOk = ready.data?.components.postgres.status === 'up';
  const redisOk = ready.data?.components.redis.status === 'up';
  const systemReady = ready.reachable && ready.data?.status === 'ready';

  return (
    <>
      <section className="panel">
        <h2>Техническое состояние системы</h2>
        <p className="lead">
          На этом этапе доступна только проверка готовности платформы. Реестр, загрузка документов и
          авторизация будут добавлены позже.
        </p>
        <div className="status-list">
          <div className="status-row">
            <span>Процесс API</span>
            <Badge ok={apiProcessOk} label={apiProcessOk ? 'работает' : 'недоступен'} />
          </div>
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
        <p className="meta">Источник API: {apiBaseUrl}</p>
        {health.error ? <p className="meta">{health.error}</p> : null}
        {ready.data?.timestamp ? (
          <p className="meta">Отметка времени готовности: {ready.data.timestamp}</p>
        ) : null}
        <a className="refresh-link" href="/">
          Обновить состояние
        </a>
      </section>
    </>
  );
}
