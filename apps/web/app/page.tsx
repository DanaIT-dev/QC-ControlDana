import { redirect } from 'next/navigation';
import { fetchCurrentUser } from '../lib/server-auth';
import { postLoginPath } from '@sgr-registry/domain';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await fetchCurrentUser();
  redirect(
    user
      ? postLoginPath(user.role, user.mustChangePassword, Boolean(user.mustCompleteProfile))
      : '/login',
  );
}
