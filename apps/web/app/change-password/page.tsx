import { redirect } from 'next/navigation';
import { fetchCurrentUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { ChangePasswordForm } from './change-password-form';

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
      <section className="panel">
        <h1>Смена временного пароля</h1>
        <p className="lead">Перед работой в реестре задайте новый пароль по политике сложности.</p>
        <ChangePasswordForm csrfToken={user.csrfToken} />
      </section>
    </AppShell>
  );
}
