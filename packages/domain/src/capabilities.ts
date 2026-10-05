import type { UserRole } from '@sgr-registry/contracts';

export const CAPABILITIES = [
  'MANAGE_ADMIN_GRANTS',
  'MANAGE_USERS',
  'CREATE_UNASSIGNED_USER',
  'VIEW_ALL_BUSINESS_DATA',
  'MANAGE_REFERENCE_DATA',
  'VIEW_REFERENCE_DATA',
  'CREATE_PROPERTY_OBJECT',
  'VIEW_SYSTEM_STATUS',
  'VIEW_ALL_ACTS',
  'VIEW_ORGANIZATION_ACTS',
  'VIEW_ASSIGNED_DEFECTS',
  'CREATE_ACT',
  'START_ACT',
  'EDIT_ACT_HEADER',
  'ADD_DEFECT',
  'EDIT_ASSIGNMENTS',
  'EDIT_PLANNED_DEADLINE',
  'EDIT_CLAIM_DEADLINE',
  'EDIT_THIRD_PARTY_DEADLINE',
  'COMPLETE_DEFECT',
  'REOPEN_DEFECT',
  'SUBMIT_DEFECT_FOR_INSPECTION',
  'ACCEPT_DEFECT_REPAIR',
  'REJECT_DEFECT_REPAIR',
  'MANAGE_PROPOSALS',
  'VIEW_PROPOSAL_A',
  'VIEW_HISTORY',
  'VIEW_ASSIGNED_HISTORY',
  'VIEW_ACT_CHAT',
  'CANCEL_ACT',
  'VIEW_ATTACHMENTS',
  'UPLOAD_ACT_ATTACHMENT',
  'UPLOAD_DEFECT_ATTACHMENT',
  'UPLOAD_PROPOSAL_ATTACHMENT',
  'ARCHIVE_ATTACHMENT',
  'DOWNLOAD_ATTACHMENT',
  'VIEW_NOTIFICATIONS',
  'VIEW_DEADLINE_CONTROL',
  'VIEW_SYSTEM_SETTINGS',
  'MANAGE_SYSTEM_SETTINGS',
  'CHANGE_OWN_PASSWORD',
  'VIEW_OWN_PROFILE',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ADMIN_CAPABILITIES = [
  'MANAGE_USERS',
  'MANAGE_REFERENCE_DATA',
  'VIEW_REFERENCE_DATA',
  'CREATE_PROPERTY_OBJECT',
  'VIEW_SYSTEM_STATUS',
  'VIEW_ALL_ACTS',
  'CREATE_ACT',
  'START_ACT',
  'EDIT_ACT_HEADER',
  'ADD_DEFECT',
  'EDIT_ASSIGNMENTS',
  'EDIT_PLANNED_DEADLINE',
  'EDIT_CLAIM_DEADLINE',
  'EDIT_THIRD_PARTY_DEADLINE',
  'COMPLETE_DEFECT',
  'REOPEN_DEFECT',
  'ACCEPT_DEFECT_REPAIR',
  'REJECT_DEFECT_REPAIR',
  'MANAGE_PROPOSALS',
  'VIEW_PROPOSAL_A',
  'VIEW_HISTORY',
  'VIEW_ACT_CHAT',
  'CANCEL_ACT',
  'VIEW_ATTACHMENTS',
  'UPLOAD_ACT_ATTACHMENT',
  'UPLOAD_DEFECT_ATTACHMENT',
  'UPLOAD_PROPOSAL_ATTACHMENT',
  'ARCHIVE_ATTACHMENT',
  'DOWNLOAD_ATTACHMENT',
  'VIEW_NOTIFICATIONS',
  'VIEW_DEADLINE_CONTROL',
  'MANAGE_SYSTEM_SETTINGS',
  'CHANGE_OWN_PASSWORD',
  'VIEW_OWN_PROFILE',
] as const satisfies readonly Capability[];

const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  SUPER_ADMIN: [
    'VIEW_ALL_BUSINESS_DATA',
    'VIEW_SYSTEM_STATUS',
    'CREATE_UNASSIGNED_USER',
    'MANAGE_ADMIN_GRANTS',
    'CHANGE_OWN_PASSWORD',
    'VIEW_OWN_PROFILE',
  ],
  PENDING_ROLE: ['CHANGE_OWN_PASSWORD', 'VIEW_OWN_PROFILE'],
  UNASSIGNED: [],
  ADMIN: ADMIN_CAPABILITIES,
  MANAGER: ADMIN_CAPABILITIES,
  SGR_MANAGER: [
    'MANAGE_REFERENCE_DATA',
    'VIEW_REFERENCE_DATA',
    'CREATE_PROPERTY_OBJECT',
    'VIEW_ALL_ACTS',
    'CREATE_ACT',
    'START_ACT',
    'EDIT_ACT_HEADER',
    'ADD_DEFECT',
    'EDIT_ASSIGNMENTS',
    'EDIT_PLANNED_DEADLINE',
    'EDIT_CLAIM_DEADLINE',
    'EDIT_THIRD_PARTY_DEADLINE',
    'COMPLETE_DEFECT',
    'REOPEN_DEFECT',
    'ACCEPT_DEFECT_REPAIR',
    'REJECT_DEFECT_REPAIR',
    'MANAGE_PROPOSALS',
    'VIEW_PROPOSAL_A',
    'VIEW_HISTORY',
    'VIEW_ACT_CHAT',
    'CANCEL_ACT',
    'VIEW_ATTACHMENTS',
    'UPLOAD_ACT_ATTACHMENT',
    'UPLOAD_DEFECT_ATTACHMENT',
    'UPLOAD_PROPOSAL_ATTACHMENT',
    'ARCHIVE_ATTACHMENT',
    'DOWNLOAD_ATTACHMENT',
    'VIEW_NOTIFICATIONS',
    'VIEW_DEADLINE_CONTROL',
    'CHANGE_OWN_PASSWORD',
    'VIEW_OWN_PROFILE',
  ],
  CONTRACTOR_ENGINEER: [
    'VIEW_ORGANIZATION_ACTS',
    'SUBMIT_DEFECT_FOR_INSPECTION',
    'EDIT_THIRD_PARTY_DEADLINE',
    'MANAGE_PROPOSALS',
    'VIEW_PROPOSAL_A',
    'VIEW_ATTACHMENTS',
    'UPLOAD_DEFECT_ATTACHMENT',
    'UPLOAD_PROPOSAL_ATTACHMENT',
    'ARCHIVE_ATTACHMENT',
    'DOWNLOAD_ATTACHMENT',
    'VIEW_NOTIFICATIONS',
    'VIEW_DEADLINE_CONTROL',
    'CHANGE_OWN_PASSWORD',
    'VIEW_OWN_PROFILE',
  ],
  RESPONSIBLE_ENGINEER: [
    'VIEW_REFERENCE_DATA',
    'VIEW_ASSIGNED_DEFECTS',
    'CREATE_ACT',
    'START_ACT',
    'EDIT_ACT_HEADER',
    'ADD_DEFECT',
    'EDIT_ASSIGNMENTS',
    'EDIT_PLANNED_DEADLINE',
    'EDIT_CLAIM_DEADLINE',
    'EDIT_THIRD_PARTY_DEADLINE',
    'COMPLETE_DEFECT',
    'REOPEN_DEFECT',
    'ACCEPT_DEFECT_REPAIR',
    'REJECT_DEFECT_REPAIR',
    'VIEW_PROPOSAL_A',
    'VIEW_ASSIGNED_HISTORY',
    'VIEW_ACT_CHAT',
    'VIEW_ATTACHMENTS',
    'UPLOAD_ACT_ATTACHMENT',
    'UPLOAD_DEFECT_ATTACHMENT',
    'ARCHIVE_ATTACHMENT',
    'DOWNLOAD_ATTACHMENT',
    'VIEW_NOTIFICATIONS',
    'VIEW_DEADLINE_CONTROL',
    'CHANGE_OWN_PASSWORD',
    'VIEW_OWN_PROFILE',
  ],
};

export const OVERSIGHT_READ_CAPABILITIES: readonly Capability[] = [
  'VIEW_REFERENCE_DATA',
  'VIEW_SYSTEM_STATUS',
  'VIEW_ALL_ACTS',
  'VIEW_ORGANIZATION_ACTS',
  'VIEW_ASSIGNED_DEFECTS',
  'VIEW_PROPOSAL_A',
  'VIEW_HISTORY',
  'VIEW_ASSIGNED_HISTORY',
  'VIEW_ACT_CHAT',
  'VIEW_ATTACHMENTS',
  'DOWNLOAD_ATTACHMENT',
  'VIEW_NOTIFICATIONS',
  'VIEW_DEADLINE_CONTROL',
  'VIEW_SYSTEM_SETTINGS',
];

const OVERSIGHT_READ_SET = new Set<Capability>(OVERSIGHT_READ_CAPABILITIES);

export const CAPABILITY_LABELS: Record<Capability, string> = {
  MANAGE_ADMIN_GRANTS: 'Назначение и снятие администраторов',
  MANAGE_USERS: 'Управление пользователями',
  CREATE_UNASSIGNED_USER: 'Создание учётной записи без рабочей роли',
  VIEW_ALL_BUSINESS_DATA: 'Полный просмотр бизнес-данных',
  MANAGE_REFERENCE_DATA: 'Управление справочниками',
  VIEW_REFERENCE_DATA: 'Просмотр справочников',
  CREATE_PROPERTY_OBJECT: 'Создание объектов',
  VIEW_SYSTEM_STATUS: 'Состояние системы',
  VIEW_ALL_ACTS: 'Просмотр всех актов',
  VIEW_ASSIGNED_DEFECTS: 'Просмотр актов закреплённых объектов',
  CREATE_ACT: 'Создание актов',
  START_ACT: 'Взятие акта в работу',
  EDIT_ACT_HEADER: 'Изменение шапки акта',
  ADD_DEFECT: 'Добавление дефектов',
  EDIT_ASSIGNMENTS: 'Назначение инженеров и организаций',
  EDIT_PLANNED_DEADLINE: 'Изменение планового срока',
  EDIT_CLAIM_DEADLINE: 'Изменение срока претензии',
  EDIT_THIRD_PARTY_DEADLINE: 'Изменение срока третьей стороны',
  COMPLETE_DEFECT: 'Завершение дефекта',
  REOPEN_DEFECT: 'Возврат дефекта в работу',
  SUBMIT_DEFECT_FOR_INSPECTION: 'Передача дефекта на проверку',
  ACCEPT_DEFECT_REPAIR: 'Приёмка устранения дефекта',
  REJECT_DEFECT_REPAIR: 'Возврат устранения на доработку',
  VIEW_ORGANIZATION_ACTS: 'Просмотр актов своей организации',
  MANAGE_PROPOSALS: 'Управление предложениями',
  VIEW_PROPOSAL_A: 'Просмотр предложения A',
  VIEW_HISTORY: 'Просмотр полной истории изменений',
  VIEW_ASSIGNED_HISTORY: 'Просмотр истории закреплённых объектов',
  VIEW_ACT_CHAT: 'Обсуждение акта',
  CANCEL_ACT: 'Аннулирование актов',
  VIEW_ATTACHMENTS: 'Просмотр вложений',
  UPLOAD_ACT_ATTACHMENT: 'Загрузка документов акта',
  UPLOAD_DEFECT_ATTACHMENT: 'Загрузка файлов дефекта',
  UPLOAD_PROPOSAL_ATTACHMENT: 'Загрузка документов предложения',
  ARCHIVE_ATTACHMENT: 'Архивирование вложений',
  DOWNLOAD_ATTACHMENT: 'Скачивание вложений',
  VIEW_NOTIFICATIONS: 'Просмотр уведомлений',
  VIEW_DEADLINE_CONTROL: 'Контроль сроков',
  VIEW_SYSTEM_SETTINGS: 'Просмотр системных настроек',
  MANAGE_SYSTEM_SETTINGS: 'Управление системными настройками',
  CHANGE_OWN_PASSWORD: 'Смена собственного пароля',
  VIEW_OWN_PROFILE: 'Просмотр собственного профиля',
};

export function capabilitiesForRole(role: UserRole): Capability[] {
  return [...ROLE_CAPABILITIES[role]];
}

export function hasCapability(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export function satisfiesCapability(role: UserRole, capability: Capability): boolean {
  if (hasCapability(role, capability)) {
    return true;
  }
  return hasCapability(role, 'VIEW_ALL_BUSINESS_DATA') && OVERSIGHT_READ_SET.has(capability);
}

export function satisfiesAnyCapability(
  role: UserRole,
  capabilities: readonly Capability[],
): boolean {
  return capabilities.some((capability) => satisfiesCapability(role, capability));
}

export function isOversightRole(role: UserRole): boolean {
  return hasCapability(role, 'VIEW_ALL_BUSINESS_DATA');
}

export function isPendingRole(role: UserRole): boolean {
  return role === 'PENDING_ROLE';
}

export function canManageUsers(role: UserRole): boolean {
  return hasCapability(role, 'MANAGE_USERS');
}

export function canManageReferenceData(role: UserRole): boolean {
  return hasCapability(role, 'MANAGE_REFERENCE_DATA');
}

export function canCreateWorkSupplier(role: UserRole): boolean {
  return canManageReferenceData(role) || hasCapability(role, 'MANAGE_PROPOSALS');
}

export function canViewReferenceData(role: UserRole): boolean {
  return satisfiesCapability(role, 'VIEW_REFERENCE_DATA');
}

export function canViewObjectsDirectory(role: UserRole): boolean {
  return satisfiesCapability(role, 'VIEW_REFERENCE_DATA');
}

export const MANAGED_REFERENCE_KINDS = [
  'property-objects',
  'organizations',
  'work-types',
  'defect-types',
] as const;

export const VIEW_ONLY_REFERENCE_KINDS = ['property-objects', 'organizations'] as const;

export type ReferenceCatalogKind = (typeof MANAGED_REFERENCE_KINDS)[number];

export function canAccessReferenceKind(role: UserRole, kind: string): boolean {
  if (
    hasCapability(role, 'MANAGE_REFERENCE_DATA') ||
    hasCapability(role, 'VIEW_ALL_BUSINESS_DATA')
  ) {
    return (MANAGED_REFERENCE_KINDS as readonly string[]).includes(kind);
  }
  if (hasCapability(role, 'VIEW_REFERENCE_DATA')) {
    return (VIEW_ONLY_REFERENCE_KINDS as readonly string[]).includes(kind);
  }
  return false;
}

export function canCreateAct(role: UserRole): boolean {
  return hasCapability(role, 'CREATE_ACT');
}

export function canCreatePropertyObject(role: UserRole): boolean {
  return hasCapability(role, 'CREATE_PROPERTY_OBJECT');
}

export function canStartAct(role: UserRole): boolean {
  return hasCapability(role, 'START_ACT');
}

export function canViewFullHistory(role: UserRole): boolean {
  return satisfiesCapability(role, 'VIEW_HISTORY');
}

export function canViewAssignedHistory(role: UserRole): boolean {
  return hasCapability(role, 'VIEW_ASSIGNED_HISTORY');
}

export function canViewHistory(role: UserRole): boolean {
  return canViewFullHistory(role) || canViewAssignedHistory(role);
}

export function canViewActChat(role: UserRole): boolean {
  return satisfiesCapability(role, 'VIEW_ACT_CHAT');
}

export function canManageAdminGrants(role: UserRole): boolean {
  return hasCapability(role, 'MANAGE_ADMIN_GRANTS');
}

export function canViewSystemSettings(role: UserRole): boolean {
  return (
    satisfiesCapability(role, 'VIEW_SYSTEM_SETTINGS') ||
    hasCapability(role, 'MANAGE_SYSTEM_SETTINGS')
  );
}

export function canManageSystemSettings(role: UserRole): boolean {
  return hasCapability(role, 'MANAGE_SYSTEM_SETTINGS');
}

export function canResolveImportedEngineer(role: UserRole): boolean {
  return role === 'ADMIN' || role === 'MANAGER' || role === 'SGR_MANAGER';
}

export function canViewEmployees(role: UserRole): boolean {
  return (
    role === 'SUPER_ADMIN' || role === 'ADMIN' || role === 'MANAGER' || role === 'SGR_MANAGER'
  );
}

export function canEditEmployment(role: UserRole): boolean {
  return role === 'ADMIN' || role === 'MANAGER' || role === 'SGR_MANAGER';
}

export function postLoginPath(
  role: UserRole,
  mustChangePassword = false,
  mustCompleteProfile = false,
): string {
  if (mustChangePassword) {
    return '/change-password';
  }
  if (mustCompleteProfile) {
    return '/complete-profile';
  }
  if (isPendingRole(role)) {
    return '/pending-role';
  }
  if (
    hasCapability(role, 'VIEW_ALL_BUSINESS_DATA') ||
    hasCapability(role, 'VIEW_ALL_ACTS') ||
    hasCapability(role, 'VIEW_ORGANIZATION_ACTS')
  ) {
    return '/registry';
  }
  if (hasCapability(role, 'MANAGE_ADMIN_GRANTS')) {
    return '/super-admin';
  }
  return '/registry';
}
