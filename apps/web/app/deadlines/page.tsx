import { Suspense } from 'react';
import { requireAppUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { TableSkeleton } from '@/components/states';
import { DeadlinesView } from './deadlines-view';

export const dynamic = 'force-dynamic';

export default async function DeadlinesPage() {
  const user = await requireAppUser();
  return (
    <AppShell user={user}>
      <Suspense fallback={<TableSkeleton />}>
        <DeadlinesView />
      </Suspense>
    </AppShell>
  );
}
