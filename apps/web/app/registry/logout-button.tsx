'use client';

import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useLogout } from '@/lib/logout';

export function LogoutButton({ csrfToken }: { csrfToken: string }) {
  const { logout, pending } = useLogout(csrfToken);
  return (
    <Button type="button" variant="outline" onClick={() => void logout()} disabled={pending}>
      {pending ? 'Выход…' : 'Выйти'}
    </Button>
  );
}

export function LogoutMenuItem({ csrfToken }: { csrfToken: string }) {
  const { logout, pending } = useLogout(csrfToken);
  return (
    <DropdownMenuItem
      variant="destructive"
      disabled={pending}
      onSelect={() => {
        void logout();
      }}
    >
      {pending ? 'Выход…' : 'Выйти'}
    </DropdownMenuItem>
  );
}
