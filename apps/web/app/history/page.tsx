import { redirect } from 'next/navigation';
import { requireBusinessUser } from '../../lib/server-auth';

export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  await requireBusinessUser();
  redirect('/registry');
}
