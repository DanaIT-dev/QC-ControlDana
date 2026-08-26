import type { UserRole } from '@sgr-registry/contracts';

export const CAPABILITIES = [
  'MANAGE_USERS',
  'MANAGE_DIRECTORIES',
  'VIEW_ALL_ACTS',
  'CREATE_ACT',
  'CANCEL_ACT',
  'VIEW_AUDIT',
  'EDIT_ANY_ACT',
  'ASSIGN_ENGINEERS',
  'VIEW_COMMERCIAL_PROPOSALS',
  'EDIT_COMMERCIAL_PROPOSALS',
  'VIEW_ASSIGNED_DEFECTS',
  'EDIT_ASSIGNED_DEFECTS',
  'COMPLETE_ASSIGNED_DEFECTS',
  'VIEW_PROPOSAL_A',
  'MANAGE_ORGANIZATIONS',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  ADMIN: [
    'MANAGE_USERS',
    'MANAGE_DIRECTORIES',
    'VIEW_ALL_ACTS',
    'CREATE_ACT',
    'CANCEL_ACT',
    'VIEW_AUDIT',
  ],
  SGR_MANAGER: [
    'VIEW_ALL_ACTS',
    'CREATE_ACT',
    'EDIT_ANY_ACT',
    'ASSIGN_ENGINEERS',
    'CANCEL_ACT',
    'VIEW_COMMERCIAL_PROPOSALS',
    'EDIT_COMMERCIAL_PROPOSALS',
    'VIEW_AUDIT',
  ],
  RESPONSIBLE_ENGINEER: [
    'VIEW_ASSIGNED_DEFECTS',
    'EDIT_ASSIGNED_DEFECTS',
    'COMPLETE_ASSIGNED_DEFECTS',
    'VIEW_PROPOSAL_A',
  ],
  CONTRACTOR_ENGINEER: [
    'VIEW_ALL_ACTS',
    'MANAGE_ORGANIZATIONS',
    'VIEW_COMMERCIAL_PROPOSALS',
    'EDIT_COMMERCIAL_PROPOSALS',
    'VIEW_AUDIT',
  ],
};

export const CAPABILITY_LABELS: Record<Capability, string> = {
  MANAGE_USERS: 'Управление пользователями',
  MANAGE_DIRECTORIES: 'Управление справочниками',
  VIEW_ALL_ACTS: 'Просмотр всех актов',
  CREATE_ACT: 'Создание актов',
  CANCEL_ACT: 'Аннулирование актов',
  VIEW_AUDIT: 'Просмотр журнала аудита',
  EDIT_ANY_ACT: 'Редактирование любых актов',
  ASSIGN_ENGINEERS: 'Назначение инженеров',
  VIEW_COMMERCIAL_PROPOSALS: 'Просмотр коммерческих предложений',
  EDIT_COMMERCIAL_PROPOSALS: 'Редактирование коммерческих предложений',
  VIEW_ASSIGNED_DEFECTS: 'Просмотр назначенных дефектов',
  EDIT_ASSIGNED_DEFECTS: 'Редактирование назначенных дефектов',
  COMPLETE_ASSIGNED_DEFECTS: 'Завершение назначенных дефектов',
  VIEW_PROPOSAL_A: 'Просмотр предложения A',
  MANAGE_ORGANIZATIONS: 'Управление организациями',
};

export function capabilitiesForRole(role: UserRole): Capability[] {
  return [...ROLE_CAPABILITIES[role]];
}

export function hasCapability(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}
