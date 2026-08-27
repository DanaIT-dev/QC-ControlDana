import type { UserRole } from '@sgr-registry/contracts';

export const CAPABILITIES = [
  'MANAGE_USERS',
  'MANAGE_REFERENCE_DATA',
  'VIEW_SYSTEM_STATUS',
  'VIEW_ALL_ACTS',
  'VIEW_ASSIGNED_DEFECTS',
  'CREATE_ACT',
  'EDIT_ACT_HEADER',
  'ADD_DEFECT',
  'EDIT_ASSIGNMENTS',
  'EDIT_PLANNED_DEADLINE',
  'EDIT_CLAIM_DEADLINE',
  'EDIT_THIRD_PARTY_DEADLINE',
  'COMPLETE_DEFECT',
  'REOPEN_DEFECT',
  'MANAGE_PROPOSALS',
  'VIEW_PROPOSAL_A',
  'VIEW_HISTORY',
  'CANCEL_ACT',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  ADMIN: [
    'MANAGE_USERS',
    'MANAGE_REFERENCE_DATA',
    'VIEW_SYSTEM_STATUS',
    'VIEW_ALL_ACTS',
    'CREATE_ACT',
    'EDIT_ACT_HEADER',
    'ADD_DEFECT',
    'EDIT_ASSIGNMENTS',
    'EDIT_PLANNED_DEADLINE',
    'EDIT_CLAIM_DEADLINE',
    'EDIT_THIRD_PARTY_DEADLINE',
    'COMPLETE_DEFECT',
    'REOPEN_DEFECT',
    'MANAGE_PROPOSALS',
    'VIEW_PROPOSAL_A',
    'VIEW_HISTORY',
    'CANCEL_ACT',
  ],
  SGR_MANAGER: [
    'MANAGE_REFERENCE_DATA',
    'VIEW_ALL_ACTS',
    'CREATE_ACT',
    'EDIT_ACT_HEADER',
    'ADD_DEFECT',
    'EDIT_ASSIGNMENTS',
    'EDIT_PLANNED_DEADLINE',
    'EDIT_CLAIM_DEADLINE',
    'EDIT_THIRD_PARTY_DEADLINE',
    'COMPLETE_DEFECT',
    'REOPEN_DEFECT',
    'MANAGE_PROPOSALS',
    'VIEW_PROPOSAL_A',
    'VIEW_HISTORY',
    'CANCEL_ACT',
  ],
  CONTRACTOR_ENGINEER: [
    'VIEW_ALL_ACTS',
    'EDIT_THIRD_PARTY_DEADLINE',
    'MANAGE_PROPOSALS',
    'VIEW_PROPOSAL_A',
    'VIEW_HISTORY',
  ],
  RESPONSIBLE_ENGINEER: [
    'VIEW_ASSIGNED_DEFECTS',
    'EDIT_PLANNED_DEADLINE',
    'COMPLETE_DEFECT',
    'VIEW_PROPOSAL_A',
    'VIEW_HISTORY',
  ],
};

export const CAPABILITY_LABELS: Record<Capability, string> = {
  MANAGE_USERS: 'Управление пользователями',
  MANAGE_REFERENCE_DATA: 'Управление справочниками',
  VIEW_SYSTEM_STATUS: 'Состояние системы',
  VIEW_ALL_ACTS: 'Просмотр всех актов',
  VIEW_ASSIGNED_DEFECTS: 'Просмотр назначенных дефектов',
  CREATE_ACT: 'Создание актов',
  EDIT_ACT_HEADER: 'Изменение шапки акта',
  ADD_DEFECT: 'Добавление дефектов',
  EDIT_ASSIGNMENTS: 'Назначение инженеров и организаций',
  EDIT_PLANNED_DEADLINE: 'Изменение планового срока',
  EDIT_CLAIM_DEADLINE: 'Изменение срока претензии',
  EDIT_THIRD_PARTY_DEADLINE: 'Изменение срока третьей стороны',
  COMPLETE_DEFECT: 'Завершение дефекта',
  REOPEN_DEFECT: 'Возврат дефекта в работу',
  MANAGE_PROPOSALS: 'Управление предложениями',
  VIEW_PROPOSAL_A: 'Просмотр предложения A',
  VIEW_HISTORY: 'Просмотр истории изменений',
  CANCEL_ACT: 'Аннулирование актов',
};

export function capabilitiesForRole(role: UserRole): Capability[] {
  return [...ROLE_CAPABILITIES[role]];
}

export function hasCapability(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export function canManageUsers(role: UserRole): boolean {
  return hasCapability(role, 'MANAGE_USERS');
}

export function canManageReferenceData(role: UserRole): boolean {
  return hasCapability(role, 'MANAGE_REFERENCE_DATA');
}

export function canCreateAct(role: UserRole): boolean {
  return hasCapability(role, 'CREATE_ACT');
}
