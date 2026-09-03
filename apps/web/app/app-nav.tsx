'use client';

import type { UserRole } from '@sgr-registry/contracts';
import { ChevronDownIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ADMINISTRATION_LABEL, navSectionsForRole, type AppNavItem } from '../lib/app-nav';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const navLinkClass = (active: boolean) =>
  cn(
    'inline-flex h-9 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-lg border-0 px-2 text-sm leading-none font-medium outline-none transition-colors select-none focus-visible:ring-3 focus-visible:ring-ring/50 2xl:px-2.5',
    active
      ? 'bg-accent text-accent-foreground'
      : 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
  );

export function AppNav({
  role,
  onNavigate,
  className,
  variant = 'desktop',
}: {
  role: UserRole;
  onNavigate?: () => void;
  className?: string;
  variant?: 'desktop' | 'drawer';
}) {
  const pathname = usePathname();
  const { primary, administration } = navSectionsForRole(role);
  const adminActive = administration.some((item) => item.match(pathname));

  if (variant === 'drawer') {
    return (
      <nav className={cn('flex flex-col gap-1', className)} aria-label="Основная навигация">
        {primary.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
        ))}
        {administration.length > 0 ? (
          <div className="mt-2 grid gap-1">
            <p className="px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground">
              {ADMINISTRATION_LABEL}
            </p>
            {administration.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
            ))}
          </div>
        ) : null}
      </nav>
    );
  }

  return (
    <nav
      data-slot="app-nav-desktop"
      className={cn('flex flex-nowrap items-center gap-0.5 2xl:gap-1', className)}
      aria-label="Основная навигация"
    >
      {primary.map((item) => (
        <NavLink key={item.href} item={item} pathname={pathname} />
      ))}
      {administration.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            type="button"
            className={cn(navLinkClass(adminActive), 'gap-1')}
            aria-haspopup="menu"
            aria-current={adminActive ? 'page' : undefined}
          >
            <span className="whitespace-nowrap">{ADMINISTRATION_LABEL}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            collisionPadding={8}
            className="z-[60] w-auto min-w-52"
          >
            {administration.map((item) => {
              const active = item.match(pathname);
              return (
                <DropdownMenuItem key={item.href} asChild className="min-h-9">
                  <Link
                    href={item.href}
                    className={cn(
                      'whitespace-nowrap',
                      active ? 'bg-accent text-accent-foreground' : undefined,
                    )}
                    aria-current={active ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </nav>
  );
}

function NavLink({
  item,
  pathname,
  onNavigate,
}: {
  item: AppNavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = item.match(pathname);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={navLinkClass(active)}
      aria-current={active ? 'page' : undefined}
    >
      {item.label}
    </Link>
  );
}
