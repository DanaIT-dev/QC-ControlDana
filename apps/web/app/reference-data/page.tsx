import {
  canManageConstructionWorkDirectory,
  canManageReferenceData,
  canOpenReferenceData,
} from '@sgr-registry/domain';
import { requireBusinessUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { ForbiddenState } from '@/components/forbidden-state';
import { ReferenceDataView } from './reference-data-view';
import { Suspense } from 'react';
import { TableSkeleton } from '@/components/states';

export const dynamic = 'force-dynamic';

export default async function ReferenceDataPage() {
  const user = await requireBusinessUser();
  if (!canOpenReferenceData(user.role)) {
    return (
      <AppShell user={user}>
        <ForbiddenState description="Недостаточно прав для просмотра справочников." />
      </AppShell>
    );
  }
  return (
    <AppShell user={user}>
      <Suspense fallback={<TableSkeleton />}>
        <ReferenceDataView
          csrfToken={user.csrfToken}
          canMutate={canManageReferenceData(user.role)}
          canEditConstruction={canManageConstructionWorkDirectory(user.role)}
          role={user.role}
        />
      </Suspense>
    </AppShell>
  );
}
