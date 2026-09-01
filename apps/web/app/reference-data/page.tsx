import { canManageReferenceData, hasCapability } from '@sgr-registry/domain';
import { requireBusinessUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { ForbiddenState } from '@/components/forbidden-state';
import { ReferenceDataView } from './reference-data-view';

export const dynamic = 'force-dynamic';

export default async function ReferenceDataPage() {
  const user = await requireBusinessUser();
  if (!hasCapability(user.role, 'VIEW_REFERENCE_DATA')) {
    return (
      <AppShell user={user}>
        <ForbiddenState description="Недостаточно прав для просмотра справочников." />
      </AppShell>
    );
  }
  return (
    <AppShell user={user}>
      <ReferenceDataView csrfToken={user.csrfToken} canMutate={canManageReferenceData(user.role)} />
    </AppShell>
  );
}
