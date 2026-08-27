import { hasCapability } from '@sgr-registry/domain';
import { requireAppUser } from '../../../lib/server-auth';
import { AppShell } from '../../app-shell';
import { ForbiddenState } from '@/components/forbidden-state';
import { CreateActForm } from './create-act-form';

export const dynamic = 'force-dynamic';

export default async function NewActPage() {
  const user = await requireAppUser();
  if (!hasCapability(user.role, 'CREATE_ACT')) {
    return (
      <AppShell user={user}>
        <ForbiddenState description="Создание актов доступно администратору и руководителю СГР." />
      </AppShell>
    );
  }
  return (
    <AppShell user={user}>
      <CreateActForm csrfToken={user.csrfToken} />
    </AppShell>
  );
}
