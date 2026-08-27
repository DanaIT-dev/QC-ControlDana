import { hasCapability } from '@sgr-registry/domain';
import { requireAppUser } from '../../../lib/server-auth';
import { AppShell } from '../../app-shell';
import { CreateActForm } from './create-act-form';

export const dynamic = 'force-dynamic';

export default async function NewActPage() {
  const user = await requireAppUser();
  if (!hasCapability(user.role, 'CREATE_ACT')) {
    return (
      <AppShell user={user}>
        <section className="panel">
          <h2>Недостаточно прав</h2>
          <p className="lead">Создание актов доступно администратору и руководителю СГР.</p>
        </section>
      </AppShell>
    );
  }
  return (
    <AppShell user={user}>
      <CreateActForm csrfToken={user.csrfToken} />
    </AppShell>
  );
}
