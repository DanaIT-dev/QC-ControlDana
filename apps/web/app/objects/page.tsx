import { canManageUsers, canViewObjectsDirectory } from '@sgr-registry/domain';
import { requireBusinessUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { ForbiddenState } from '@/components/forbidden-state';
import { TableSkeleton } from '@/components/states';
import { Suspense } from 'react';
import { ObjectsView } from './objects-view';

export const dynamic = 'force-dynamic';

export default async function ObjectsPage() {
  const user = await requireBusinessUser();
  if (!canViewObjectsDirectory(user.role)) {
    return (
      <AppShell user={user}>
        <ForbiddenState description="Недостаточно прав для просмотра объектов." />
      </AppShell>
    );
  }
  return (
    <AppShell user={user}>
      <Suspense fallback={<TableSkeleton />}>
        <ObjectsView csrfToken={user.csrfToken} canManageLinks={canManageUsers(user.role)} />
      </Suspense>
    </AppShell>
  );
}
