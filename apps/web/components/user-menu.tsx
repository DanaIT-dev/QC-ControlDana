'use client';

import type { SafeUserProfile } from '@sgr-registry/contracts';
import { formatPersonShort } from '@sgr-registry/domain';
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
          className="h-9 min-h-9 max-w-[min(18rem,42vw)] shrink-0 gap-2 overflow-hidden px-2 whitespace-nowrap 2xl:max-w-88"
          aria-label="Меню пользователя"
        >
          <UserAvatar name={user.fullName} />
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className="min-w-0 max-w-30 truncate text-sm leading-5 font-medium 2xl:max-w-48"
              title={user.fullName}
              aria-label={user.fullName}
            >
              {formatPersonShort(
                user.lastName && user.firstName
                  ? {
                      lastName: user.lastName,
                      firstName: user.firstName,
                      middleName: user.middleName ?? null,
                    }
                  : user.fullName,
              )}
            </span>
            <span
              className="min-w-0 max-w-28 truncate text-[12px] leading-5 font-normal text-muted-foreground 2xl:max-w-44"
              title={user.roleLabel}
            >
              {user.roleLabel}
            </span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="grid gap-0.5">
            <span className="text-sm font-medium wrap-break-word">{user.fullName}</span>
            <span className="text-xs break-all text-muted-foreground">{user.email}</span>
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              {user.roleLabel}
            </span>
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
          <p
            className="truncate text-sm font-medium"
            title={user.fullName}
            aria-label={user.fullName}
          >
            {formatPersonShort(
              user.lastName && user.firstName
                ? {
                    lastName: user.lastName,
                    firstName: user.firstName,
                    middleName: user.middleName ?? null,
                  }
                : user.fullName,
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground" title={user.roleLabel}>
            {user.roleLabel}
          </p>
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
