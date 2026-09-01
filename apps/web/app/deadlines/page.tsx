import { Suspense } from 'react';
import { requireBusinessUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { TableSkeleton } from '@/components/states';
import { DeadlinesView } from './deadlines-view';

export const dynamic = 'force-dynamic';

export default async function DeadlinesPage() {
  const user = await requireBusinessUser();
  return (
    <AppShell user={user}>
      <Suspense fallback={<TableSkeleton />}>
        <DeadlinesView />
      </Suspense>
    </AppShell>
  );
}
