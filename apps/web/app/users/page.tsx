import { hasCapability } from '@sgr-registry/domain';
import { requireBusinessUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { ForbiddenState } from '@/components/forbidden-state';
import { UsersView } from './users-view';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const user = await requireBusinessUser();
  if (!hasCapability(user.role, 'MANAGE_USERS')) {
    return (
      <AppShell user={user}>
        <ForbiddenState description="Раздел доступен только администратору." />
      </AppShell>
    );
  }
  return (
    <AppShell user={user}>
      <UsersView csrfToken={user.csrfToken} currentUserId={user.id} />
    </AppShell>
  );
}
