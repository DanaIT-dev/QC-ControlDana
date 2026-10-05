import {
  canManageUsers,
  canViewEmployees,
  hasCapability,
  isProfileEditorRole,
} from '@sgr-registry/domain';
import { requireBusinessUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { ForbiddenState } from '@/components/forbidden-state';
import { UsersView } from './users-view';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const user = await requireBusinessUser();
  const canManage = canManageUsers(user.role);
  const canCreateUnassigned = hasCapability(user.role, 'CREATE_UNASSIGNED_USER');
  if (!canViewEmployees(user.role)) {
    return (
      <AppShell user={user}>
        <ForbiddenState description="Раздел доступен суперадминистратору, администратору и руководителям." />
      </AppShell>
    );
  }
  return (
    <AppShell user={user}>
      <UsersView
        csrfToken={user.csrfToken}
        currentUserId={user.id}
        currentUserRole={user.role}
        canManage={canManage}
        canCreateUnassigned={canCreateUnassigned}
        canEditProfiles={isProfileEditorRole(user.role)}
      />
    </AppShell>
  );
}
