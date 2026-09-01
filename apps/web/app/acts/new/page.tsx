import { hasCapability } from '@sgr-registry/domain';
import { requireBusinessUser } from '../../../lib/server-auth';
import { AppShell } from '../../app-shell';
import { ForbiddenState } from '@/components/forbidden-state';
import { CreateActForm } from './create-act-form';

export const dynamic = 'force-dynamic';

export default async function NewActPage() {
  const user = await requireBusinessUser();
  if (!hasCapability(user.role, 'CREATE_ACT')) {
    return (
      <AppShell user={user}>
        <ForbiddenState description="Недостаточно прав для создания акта." />
      </AppShell>
    );
  }
  return (
    <AppShell user={user}>
      <CreateActForm csrfToken={user.csrfToken} />
    </AppShell>
  );
}
