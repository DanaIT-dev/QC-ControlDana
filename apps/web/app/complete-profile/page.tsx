import { redirect } from 'next/navigation';
import { postLoginPath } from '@sgr-registry/domain';
import { fetchCurrentUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { CompleteProfileForm } from './complete-profile-form';

export const dynamic = 'force-dynamic';

export default async function CompleteProfilePage() {
  const user = await fetchCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (user.mustChangePassword) {
    redirect('/change-password');
  }
  if (!user.mustCompleteProfile) {
    redirect(postLoginPath(user.role));
  }
  return (
    <AppShell user={user}>
      <CompleteProfileForm
        csrfToken={user.csrfToken}
        role={user.role}
        lastName={user.lastName ?? ''}
        firstName={user.firstName ?? ''}
        middleName={user.middleName ?? ''}
      />
    </AppShell>
  );
}
