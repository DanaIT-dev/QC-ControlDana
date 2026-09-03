import { hasCapability, isPendingRole, satisfiesCapability } from '@sgr-registry/domain';
import type { UserRole } from '@sgr-registry/contracts';

export interface AppNavItem {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
}

export function navItemsForRole(role: UserRole): AppNavItem[] {
  if (isPendingRole(role)) {
    return [];
  }
  const items: AppNavItem[] = [];
  if (
    satisfiesCapability(role, 'VIEW_ALL_ACTS') ||
    satisfiesCapability(role, 'VIEW_ASSIGNED_DEFECTS')
  ) {
    items.push({
      href: '/registry',
      label: 'Реестр',
      match: (pathname) =>
        pathname === '/registry' || (pathname.startsWith('/acts/') && pathname !== '/acts/new'),
    });
  }
  if (satisfiesCapability(role, 'VIEW_REFERENCE_DATA')) {
    items.push({
      href: '/objects',
      label: 'Объекты',
      match: (pathname) => pathname === '/objects' || pathname.startsWith('/objects/'),
    });
  }
  if (hasCapability(role, 'CREATE_ACT')) {
    items.push({
      href: '/acts/new',
      label: 'Создать акт',
      match: (pathname) => pathname === '/acts/new',
    });
  }
  if (satisfiesCapability(role, 'VIEW_DEADLINE_CONTROL')) {
    items.push({
      href: '/deadlines',
      label: 'Контроль сроков',
      match: (pathname) => pathname.startsWith('/deadlines'),
    });
  }
  if (satisfiesCapability(role, 'VIEW_NOTIFICATIONS')) {
    items.push({
      href: '/notifications',
      label: 'Уведомления',
      match: (pathname) => pathname.startsWith('/notifications'),
    });
  }
  if (satisfiesCapability(role, 'VIEW_REFERENCE_DATA')) {
    items.push({
      href: '/reference-data',
      label: 'Справочники',
      match: (pathname) => pathname.startsWith('/reference-data'),
    });
  }
  if (satisfiesCapability(role, 'VIEW_HISTORY')) {
    items.push({
      href: '/history',
      label: 'Журнал аудита',
      match: (pathname) => pathname === '/history' || pathname.startsWith('/history/'),
    });
  }
  if (
    hasCapability(role, 'MANAGE_USERS') ||
    hasCapability(role, 'CREATE_UNASSIGNED_USER') ||
    hasCapability(role, 'VIEW_ALL_BUSINESS_DATA')
  ) {
    items.push({
      href: '/users',
      label: 'Пользователи',
      match: (pathname) => pathname.startsWith('/users'),
    });
  }
  if (satisfiesCapability(role, 'VIEW_SYSTEM_STATUS')) {
    items.push({
      href: '/system-status',
      label: 'Состояние системы',
      match: (pathname) => pathname === '/system-status',
    });
  }
  if (hasCapability(role, 'MANAGE_ADMIN_GRANTS')) {
    items.push({
      href: '/super-admin',
      label: 'Администраторы',
      match: (pathname) => pathname.startsWith('/super-admin'),
    });
  }
  return items;
}
