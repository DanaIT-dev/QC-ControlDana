import { requireSuperAdminUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { SuperAdminView } from './super-admin-view';

export const dynamic = 'force-dynamic';

export default async function SuperAdminPage() {
  const user = await requireSuperAdminUser();
  return (
    <AppShell user={user}>
      <SuperAdminView csrfToken={user.csrfToken} />
    </AppShell>
  );
}
