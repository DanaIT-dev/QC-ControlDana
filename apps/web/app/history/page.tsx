import { Suspense } from 'react';
import { canViewFullHistory } from '@sgr-registry/domain';
import { requireBusinessUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { ForbiddenState } from '@/components/forbidden-state';
import { TableSkeleton } from '@/components/states';
import { AuditLogView } from './audit-log-view';

export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  const user = await requireBusinessUser();
  if (!canViewFullHistory(user.role)) {
    return (
      <AppShell user={user}>
        <ForbiddenState description="Журнал аудита доступен только для полного просмотра истории." />
      </AppShell>
    );
  }
  return (
    <AppShell user={user}>
      <Suspense fallback={<TableSkeleton />}>
        <AuditLogView />
      </Suspense>
    </AppShell>
  );
}
