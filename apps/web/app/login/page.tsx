import { redirect } from 'next/navigation';
import { fetchCurrentUser } from '../../lib/server-auth';
import { QcLogo } from '@/components/qc-logo';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const user = await fetchCurrentUser();
  if (user?.mustChangePassword) {
    redirect('/change-password');
  }
  if (user) {
    redirect('/registry');
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-x-hidden px-4 py-8">
      <div
        aria-hidden
        data-login-backdrop
        className="absolute inset-0 bg-slate-950 bg-[url('/login-background.jpg')] bg-cover bg-center bg-no-repeat"
      />
      <div aria-hidden className="absolute inset-0 bg-slate-950/40" />
      <Card className="relative z-10 w-full max-w-[440px] rounded-xl shadow-lg">
        <CardHeader className="gap-2">
          <QcLogo size="login" />
          <h1 className="text-2xl font-semibold">Реестр дефектных актов</h1>
          <CardDescription>Служба гарантийного ремонта</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
