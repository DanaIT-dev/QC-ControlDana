'use client';

import { CSRF_HEADER_NAME } from '@sgr-registry/domain';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function useLogout(csrfToken: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  async function logout() {
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
      queryClient.clear();
      router.replace('/login');
      router.refresh();
    }
  }

  return { logout, pending };
}
