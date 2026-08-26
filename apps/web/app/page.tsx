import { redirect } from 'next/navigation';
import { fetchCurrentUser } from '../lib/server-auth';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await fetchCurrentUser();
  redirect(user ? '/registry' : '/login');
}
