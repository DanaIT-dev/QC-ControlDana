import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { satisfiesCapability } from '@sgr-registry/domain';
import { requireBusinessUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { TableSkeleton } from '@/components/states';
import { AnalyticsView } from './analytics-view';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const user = await requireBusinessUser();
  if (!satisfiesCapability(user.role, 'VIEW_QUALITY_ANALYTICS')) {
    redirect('/registry');
  }
  return (
    <AppShell user={user}>
      <Suspense fallback={<TableSkeleton />}>
        <AnalyticsView csrfToken={user.csrfToken} />
      </Suspense>
    </AppShell>
  );
}
