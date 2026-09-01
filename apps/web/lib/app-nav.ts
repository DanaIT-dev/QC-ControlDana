import { hasCapability } from '@sgr-registry/domain';
import type { UserRole } from '@sgr-registry/contracts';

export interface AppNavItem {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
}

export function navItemsForRole(role: UserRole): AppNavItem[] {
  if (hasCapability(role, 'MANAGE_ADMIN_GRANTS') && !hasCapability(role, 'VIEW_ALL_ACTS')) {
    return [
      {
        href: '/super-admin',
        label: 'Администраторы',
        match: (pathname) => pathname.startsWith('/super-admin'),
      },
    ];
  }
  const items: AppNavItem[] = [
    {
      href: '/registry',
      label: 'Реестр',
      match: (pathname) =>
        pathname === '/registry' || (pathname.startsWith('/acts/') && pathname !== '/acts/new'),
    },
  ];
  if (hasCapability(role, 'CREATE_ACT')) {
    items.push({
      href: '/acts/new',
      label: 'Создать акт',
      match: (pathname) => pathname === '/acts/new',
    });
  }
  if (hasCapability(role, 'VIEW_DEADLINE_CONTROL')) {
    items.push({
      href: '/deadlines',
      label: 'Контроль сроков',
      match: (pathname) => pathname.startsWith('/deadlines'),
    });
  }
  if (hasCapability(role, 'VIEW_REFERENCE_DATA')) {
    items.push({
      href: '/reference-data',
      label: 'Справочники',
      match: (pathname) => pathname.startsWith('/reference-data'),
    });
  }
  if (hasCapability(role, 'MANAGE_USERS')) {
    items.push({
      href: '/users',
      label: 'Пользователи',
      match: (pathname) => pathname.startsWith('/users'),
    });
  }
  if (hasCapability(role, 'VIEW_SYSTEM_STATUS')) {
    items.push({
      href: '/system-status',
      label: 'Состояние системы',
      match: (pathname) => pathname === '/system-status',
    });
  }
  return items;
}
