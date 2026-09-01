import { redirect } from 'next/navigation';
import { postLoginPath } from '@sgr-registry/domain';
import { fetchCurrentUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { ChangePasswordCard, ChangePasswordForm } from './change-password-form';

export const dynamic = 'force-dynamic';

export default async function ChangePasswordPage() {
  const user = await fetchCurrentUser();
  if (!user) {
    redirect('/login');
  }
  return (
    <AppShell user={user}>
      <ChangePasswordCard>
        <ChangePasswordForm csrfToken={user.csrfToken} nextPath={postLoginPath(user.role)} />
      </ChangePasswordCard>
    </AppShell>
  );
}
