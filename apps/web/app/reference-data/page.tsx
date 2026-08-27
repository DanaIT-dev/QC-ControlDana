import { hasCapability } from '@sgr-registry/domain';
import { requireAppUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { ReferenceDataView } from './reference-data-view';

export const dynamic = 'force-dynamic';

export default async function ReferenceDataPage() {
  const user = await requireAppUser();
  if (!hasCapability(user.role, 'MANAGE_REFERENCE_DATA')) {
    return (
      <AppShell user={user}>
        <section className="panel">
          <h2>Недостаточно прав</h2>
          <p className="lead">Справочники доступны руководителю СГР и администратору.</p>
        </section>
      </AppShell>
    );
  }
  return (
    <AppShell user={user}>
      <ReferenceDataView csrfToken={user.csrfToken} />
    </AppShell>
  );
}
