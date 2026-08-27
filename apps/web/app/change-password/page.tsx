import { redirect } from 'next/navigation';
import { fetchCurrentUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { ChangePasswordCard, ChangePasswordForm } from './change-password-form';

export const dynamic = 'force-dynamic';

export default async function ChangePasswordPage() {
  const user = await fetchCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (!user.mustChangePassword) {
    redirect('/registry');
  }
  return (
    <AppShell user={user}>
      <ChangePasswordCard>
        <ChangePasswordForm csrfToken={user.csrfToken} />
      </ChangePasswordCard>
    </AppShell>
  );
}
