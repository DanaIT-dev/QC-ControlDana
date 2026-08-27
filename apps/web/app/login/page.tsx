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
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-[440px] rounded-xl shadow-sm">
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
