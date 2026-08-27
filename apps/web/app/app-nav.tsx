'use client';

import type { UserRole } from '@sgr-registry/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { navItemsForRole } from '../lib/app-nav';
import { cn } from '@/lib/utils';

export function AppNav({
  role,
  onNavigate,
  className,
}: {
  role: UserRole;
  onNavigate?: () => void;
  className?: string;
}) {
  const pathname = usePathname();
  return (
    <nav
      className={cn('flex flex-col gap-1 md:flex-row md:items-center md:gap-1', className)}
      aria-label="Основная навигация"
    >
      {navItemsForRole(role).map((item) => {
        const active = item.match(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              'inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium transition-colors',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            aria-current={active ? 'page' : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
