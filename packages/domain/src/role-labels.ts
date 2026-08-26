import type { UserRole } from '@sgr-registry/contracts';

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Администратор',
  SGR_MANAGER: 'Руководитель СГР',
  RESPONSIBLE_ENGINEER: 'Ответственный инженер',
  CONTRACTOR_ENGINEER: 'Инженер по работе с подрядчиками',
};

export function roleLabel(role: UserRole): string {
  return USER_ROLE_LABELS[role];
}
