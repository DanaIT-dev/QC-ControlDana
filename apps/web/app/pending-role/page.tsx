import { redirect } from 'next/navigation';
import { isPendingRole, postLoginPath } from '@sgr-registry/domain';
import { requireAppUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function PendingRolePage() {
  const user = await requireAppUser();
  if (!isPendingRole(user.role)) {
    redirect(postLoginPath(user.role, user.mustChangePassword));
  }
  return (
    <AppShell user={user}>
      <Card className="mx-auto max-w-xl shadow-none">
        <CardHeader>
          <CardTitle>Ожидается назначение роли</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <p>Учетная запись создана. Ожидается назначение роли администратором.</p>
          <p>После назначения роли войдите снова или обновите страницу.</p>
        </CardContent>
      </Card>
    </AppShell>
  );
}
