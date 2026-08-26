import { redirect } from 'next/navigation';
import { fetchCapabilities, fetchCurrentUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { LogoutButton } from './logout-button';

export const dynamic = 'force-dynamic';

export default async function RegistryPage() {
  const user = await fetchCurrentUser();
  if (!user) {
    redirect('/login');
  }
  const capabilities = await fetchCapabilities();

  return (
    <AppShell>
      <section className="panel registry-panel">
        <h2>Реестр дефектных актов</h2>
        <p className="lead">
          {user.fullName} · {user.roleLabel}
        </p>
        <p className="meta">Рабочий реестр актов будет добавлен следующим этапом.</p>
        {capabilities ? (
          <ul className="capability-list">
            {capabilities.capabilities.map((capability) => (
              <li key={capability}>{capabilities.capabilityLabels[capability] ?? capability}</li>
            ))}
          </ul>
        ) : null}
        <div className="registry-actions">
          <LogoutButton csrfToken={user.csrfToken} />
          {user.role === 'ADMIN' ? (
            <a className="text-link" href="/system-status">
              Техническое состояние
            </a>
          ) : null}
        </div>
      </section>
    </AppShell>
  );
}
