import { Suspense } from 'react';
import { requireAppUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { TableSkeleton } from '@/components/states';
import { NotificationsView } from './notifications-view';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const user = await requireAppUser();
  return (
    <AppShell user={user}>
      <Suspense fallback={<TableSkeleton />}>
        <NotificationsView csrfToken={user.csrfToken} />
      </Suspense>
    </AppShell>
  );
}
