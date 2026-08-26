'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function AppNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="site-nav" aria-label="Основная навигация">
      <Link
        className={navClass(pathname === '/registry' || pathname.startsWith('/acts/'))}
        href="/registry"
      >
        Реестр
      </Link>
      {isAdmin ? (
        <Link className={navClass(pathname === '/system-status')} href="/system-status">
          Состояние системы
        </Link>
      ) : null}
    </nav>
  );
}

function navClass(active: boolean): string {
  return active ? 'site-nav__link site-nav__link--active' : 'site-nav__link';
}
