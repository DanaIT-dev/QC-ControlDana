'use client';

import { CSRF_HEADER_NAME } from '@sgr-registry/domain';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function LogoutButton({ csrfToken, className }: { csrfToken: string; className?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onLogout() {
    if (pending) {
      return;
    }
    setPending(true);
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          [CSRF_HEADER_NAME]: csrfToken,
        },
        body: '{}',
      });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      className={className ?? 'primary-button'}
      onClick={onLogout}
      disabled={pending}
    >
      {pending ? 'Выход…' : 'Выйти'}
    </button>
  );
}
