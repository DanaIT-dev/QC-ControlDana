import { Suspense } from 'react';
import { requireBusinessUser } from '../../lib/server-auth';
import { AppShell } from '../app-shell';
import { TableSkeleton } from '@/components/states';
import { RegistryView } from './registry-view';

export const dynamic = 'force-dynamic';

export default async function RegistryPage() {
  const user = await requireBusinessUser();
  return (
    <AppShell user={user}>
      <Suspense fallback={<TableSkeleton />}>
        <RegistryView user={user} />
      </Suspense>
    </AppShell>
  );
}
