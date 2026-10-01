import { hasCapability, isPendingRole, satisfiesCapability } from '@sgr-registry/domain';
import type { UserRole } from '@sgr-registry/contracts';

export interface AppNavItem {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
}

export interface AppNavSections {
  primary: AppNavItem[];
  administration: AppNavItem[];
}

export const ADMINISTRATION_LABEL = 'Администрирование';

export function navSectionsForRole(role: UserRole): AppNavSections {
  if (isPendingRole(role)) {
    return { primary: [], administration: [] };
  }
  const primary: AppNavItem[] = [];
  const administration: AppNavItem[] = [];
  if (
    satisfiesCapability(role, 'VIEW_ALL_ACTS') ||
    satisfiesCapability(role, 'VIEW_ORGANIZATION_ACTS') ||
    satisfiesCapability(role, 'VIEW_ASSIGNED_DEFECTS')
  ) {
    primary.push({
      href: '/registry',
      label: 'Реестр',
      match: (pathname) =>
        pathname === '/registry' || (pathname.startsWith('/acts/') && pathname !== '/acts/new'),
    });
  }
  if (satisfiesCapability(role, 'VIEW_REFERENCE_DATA')) {
    primary.push({
      href: '/objects',
      label: 'Объекты',
      match: (pathname) => pathname === '/objects' || pathname.startsWith('/objects/'),
    });
  }
  if (hasCapability(role, 'CREATE_ACT')) {
    primary.push({
      href: '/acts/new',
      label: 'Создать акт',
      match: (pathname) => pathname === '/acts/new',
    });
  }
  if (satisfiesCapability(role, 'VIEW_DEADLINE_CONTROL')) {
    primary.push({
      href: '/deadlines',
      label: 'Контроль сроков',
      match: (pathname) => pathname.startsWith('/deadlines'),
    });
  }
  if (satisfiesCapability(role, 'VIEW_NOTIFICATIONS')) {
    primary.push({
      href: '/notifications',
      label: 'Уведомления',
      match: (pathname) => pathname.startsWith('/notifications'),
    });
  }
  if (satisfiesCapability(role, 'VIEW_REFERENCE_DATA')) {
    primary.push({
      href: '/reference-data',
      label: 'Справочники',
      match: (pathname) => pathname.startsWith('/reference-data'),
    });
  }
  if (
    hasCapability(role, 'MANAGE_USERS') ||
    hasCapability(role, 'CREATE_UNASSIGNED_USER') ||
    hasCapability(role, 'VIEW_ALL_BUSINESS_DATA')
  ) {
    administration.push({
      href: '/users',
      label: 'Пользователи',
      match: (pathname) => pathname.startsWith('/users'),
    });
  }
  if (hasCapability(role, 'MANAGE_ADMIN_GRANTS')) {
    administration.push({
      href: '/super-admin',
      label: 'Администраторы',
      match: (pathname) => pathname.startsWith('/super-admin'),
    });
  }
  if (satisfiesCapability(role, 'VIEW_HISTORY')) {
    administration.push({
      href: '/history',
      label: 'Журнал аудита',
      match: (pathname) => pathname === '/history' || pathname.startsWith('/history/'),
    });
  }
  if (satisfiesCapability(role, 'VIEW_SYSTEM_STATUS')) {
    administration.push({
      href: '/system-status',
      label: 'Состояние системы',
      match: (pathname) => pathname === '/system-status',
    });
  }
  return { primary, administration };
}

export function navItemsForRole(role: UserRole): AppNavItem[] {
  const { primary, administration } = navSectionsForRole(role);
  return [...primary, ...administration];
}
