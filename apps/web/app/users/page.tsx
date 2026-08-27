import { hasCapability } from '@sgr-registry/domain';
import { requireAppUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { UsersView } from './users-view';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const user = await requireAppUser();
  if (!hasCapability(user.role, 'MANAGE_USERS')) {
    return (
      <AppShell user={user}>
        <section className="panel">
          <h2>Недостаточно прав</h2>
          <p className="lead">Раздел доступен только администратору.</p>
        </section>
      </AppShell>
    );
  }
  return (
    <AppShell user={user}>
      <UsersView csrfToken={user.csrfToken} currentUserId={user.id} />
    </AppShell>
  );
}
