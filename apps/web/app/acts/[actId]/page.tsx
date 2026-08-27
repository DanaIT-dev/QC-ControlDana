import { Suspense } from 'react';
import { requireAppUser } from '../../../lib/server-auth';
import { AppShell } from '../../app-shell';
import { ActDetailView } from './act-detail';

export const dynamic = 'force-dynamic';

export default async function ActPage({ params }: { params: Promise<{ actId: string }> }) {
  const user = await requireAppUser();
  const { actId } = await params;
  return (
    <AppShell user={user}>
      <Suspense fallback={<section className="panel">Загрузка карточки…</section>}>
        <ActDetailView actId={actId} user={user} />
      </Suspense>
    </AppShell>
  );
}
