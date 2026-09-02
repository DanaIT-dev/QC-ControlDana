import { Suspense } from 'react';
import { isOversightRole } from '@sgr-registry/domain';
import { requireBusinessUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { TableSkeleton } from '@/components/states';
import { NotificationsView } from './notifications-view';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const user = await requireBusinessUser();
  return (
    <AppShell user={user}>
      <Suspense fallback={<TableSkeleton />}>
        <NotificationsView csrfToken={user.csrfToken} canMutate={!isOversightRole(user.role)} />
      </Suspense>
    </AppShell>
  );
}
