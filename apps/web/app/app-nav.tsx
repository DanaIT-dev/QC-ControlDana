'use client';

import { hasCapability } from '@sgr-registry/domain';
import type { UserRole } from '@sgr-registry/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function AppNav({ role }: { role: UserRole }) {
  const pathname = usePathname();
  return (
    <nav className="site-nav" aria-label="Основная навигация">
      <Link
        className={navClass(
          pathname === '/registry' || (pathname.startsWith('/acts/') && pathname !== '/acts/new'),
        )}
        href="/registry"
      >
        Реестр
      </Link>
      {hasCapability(role, 'CREATE_ACT') ? (
        <Link className={navClass(pathname === '/acts/new')} href="/acts/new">
          Создать акт
        </Link>
      ) : null}
      {hasCapability(role, 'MANAGE_REFERENCE_DATA') ? (
        <Link className={navClass(pathname.startsWith('/reference-data'))} href="/reference-data">
          Справочники
        </Link>
      ) : null}
      {hasCapability(role, 'MANAGE_USERS') ? (
        <Link className={navClass(pathname.startsWith('/users'))} href="/users">
          Пользователи
        </Link>
      ) : null}
      {hasCapability(role, 'VIEW_SYSTEM_STATUS') ? (
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
