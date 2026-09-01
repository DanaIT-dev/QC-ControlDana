'use client';

import type { SafeUserProfile } from '@sgr-registry/contracts';
import { LogOutIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/user-avatar';
import { LogoutMenuItem } from '@/app/registry/logout-button';
import { useLogout } from '@/lib/logout';

export function UserMenu({ user }: { user: SafeUserProfile }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-11 min-h-11 gap-2 px-2"
          aria-label="Меню пользователя"
        >
          <UserAvatar name={user.fullName} />
          <span className="hidden text-left md:grid">
            <span className="text-sm font-medium leading-tight">{user.fullName}</span>
            <span className="text-[12px] font-normal text-muted-foreground">{user.roleLabel}</span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="grid gap-0.5">
            <span className="text-sm font-medium">{user.fullName}</span>
            <span className="text-xs text-muted-foreground">{user.email}</span>
            <span className="text-xs text-muted-foreground">{user.roleLabel}</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="/change-password">Сменить пароль</a>
        </DropdownMenuItem>
        <LogoutMenuItem csrfToken={user.csrfToken} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MobileUserBlock({ user }: { user: SafeUserProfile }) {
  const { logout, pending } = useLogout(user.csrfToken);
  return (
    <div className="border-t pt-4">
      <div className="mb-3 flex items-center gap-3">
        <UserAvatar name={user.fullName} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{user.fullName}</p>
          <p className="truncate text-xs text-muted-foreground">{user.roleLabel}</p>
        </div>
      </div>
      <Button asChild variant="outline" className="mb-2 min-h-11 w-full">
        <a href="/change-password">Сменить пароль</a>
      </Button>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => void logout()}
        disabled={pending}
      >
        <LogOutIcon data-icon="inline-start" />
        {pending ? 'Выход…' : 'Выйти'}
      </Button>
    </div>
  );
}
