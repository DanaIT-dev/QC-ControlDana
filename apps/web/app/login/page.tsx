import { redirect } from 'next/navigation';
import { fetchCurrentUser } from '../../lib/server-auth';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const user = await fetchCurrentUser();
  if (user) {
    redirect('/registry');
  }

  return (
    <main className="login-layout">
      <section className="login-panel">
        <p className="login-kicker">Dana Holding · внутренний продукт</p>
        <h1 className="login-title">Реестр дефектных актов</h1>
        <p className="login-subtitle">Служба гарантийного ремонта</p>
        <LoginForm />
      </section>
    </main>
  );
}
