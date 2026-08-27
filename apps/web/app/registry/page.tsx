import { Suspense } from 'react';
import { requireAppUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { RegistryView } from './registry-view';

export const dynamic = 'force-dynamic';

export default async function RegistryPage() {
  const user = await requireAppUser();
  return (
    <AppShell user={user}>
      <Suspense fallback={<section className="panel">Загрузка реестра…</section>}>
        <RegistryView user={user} />
      </Suspense>
    </AppShell>
  );
}
