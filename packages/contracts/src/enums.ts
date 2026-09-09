export const ACT_FORM_CODES = ['S1', 'S23'] as const;
export type ActFormCode = (typeof ACT_FORM_CODES)[number];

export const ACT_STATUSES = [
  'NEW',
  'IMPORTED_UNSPECIFIED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ActStatus = (typeof ACT_STATUSES)[number];

export const REGISTRY_STATUS_FILTERS = [
  'NEW',
  'IMPORTED_UNSPECIFIED',
  'IN_PROGRESS',
  'COMPLETED',
] as const;
export type RegistryStatusFilter = (typeof REGISTRY_STATUS_FILTERS)[number];

export const DEFECT_ITEM_STATUSES = ['IN_PROGRESS', 'COMPLETED'] as const;
export type DefectItemStatus = (typeof DEFECT_ITEM_STATUSES)[number];

export const USER_ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'MANAGER',
  'SGR_MANAGER',
  'RESPONSIBLE_ENGINEER',
  'CONTRACTOR_ENGINEER',
  'PENDING_ROLE',
  'UNASSIGNED',
] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const STAFF_ASSIGNABLE_ROLES = [
  'SGR_MANAGER',
  'RESPONSIBLE_ENGINEER',
  'CONTRACTOR_ENGINEER',
] as const;
export type StaffAssignableRole = (typeof STAFF_ASSIGNABLE_ROLES)[number];

export const OPERATIONAL_ASSIGNABLE_ROLES = ['MANAGER', ...STAFF_ASSIGNABLE_ROLES] as const;
export type OperationalAssignableRole = (typeof OPERATIONAL_ASSIGNABLE_ROLES)[number];

export const PENDING_USER_ROLE = 'PENDING_ROLE' as const;
export const UNASSIGNED_ROLE = 'UNASSIGNED' as const;

export const ADMIN_ELIGIBLE_ROLES = [
  'MANAGER',
  'SGR_MANAGER',
  'RESPONSIBLE_ENGINEER',
  'CONTRACTOR_ENGINEER',
  'PENDING_ROLE',
] as const;
export type AdminEligibleRole = (typeof ADMIN_ELIGIBLE_ROLES)[number];

export const ADMIN_PREVIOUS_ROLES = [
  'MANAGER',
  'SGR_MANAGER',
  'RESPONSIBLE_ENGINEER',
  'CONTRACTOR_ENGINEER',
  'UNASSIGNED',
] as const;
export type AdminPreviousRole = (typeof ADMIN_PREVIOUS_ROLES)[number];

export const ADMIN_BACKFILL_PREVIOUS_ROLE = 'UNASSIGNED' as const;

export const MANAGED_USER_ROLES = ['ADMIN', 'MANAGER', ...STAFF_ASSIGNABLE_ROLES] as const;
export type ManagedUserRole = (typeof MANAGED_USER_ROLES)[number];

export const LISTABLE_USER_ROLES = [...MANAGED_USER_ROLES, 'PENDING_ROLE'] as const;
export type ListableUserRole = (typeof LISTABLE_USER_ROLES)[number];

export const USERS_LIST_ROLE_FILTERS = [...LISTABLE_USER_ROLES, 'SUPER_ADMIN'] as const;
export type UsersListRoleFilter = (typeof USERS_LIST_ROLE_FILTERS)[number];

export const USER_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ORGANIZATION_ROLES = [
  'CUSTOMER',
  'LIABLE_CONTRACTOR',
  'ALTERNATIVE_CONTRACTOR',
] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const PROPOSAL_SLOTS = ['A', 'B', 'C'] as const;
export type ProposalSlot = (typeof PROPOSAL_SLOTS)[number];

export const PROPOSAL_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const DEADLINE_STATES = [
  'NO_DEADLINE',
  'NORMAL',
  'WARNING',
  'OVERDUE',
  'COMPLETED',
] as const;
export type DeadlineState = (typeof DEADLINE_STATES)[number];

export const SLA_CLOCK_KINDS = ['GENERAL', 'THIRD_PARTY'] as const;
export type SlaClockKind = (typeof SLA_CLOCK_KINDS)[number];

export const SLA_CLOCK_STATES = [
  'NO_DEADLINE',
  'NORMAL',
  'WARNING',
  'DUE_TODAY',
  'OVERDUE',
  'COMPLETED',
] as const;
export type SlaClockState = (typeof SLA_CLOCK_STATES)[number];

export const NOTIFICATION_TYPES = [
  'RESPONSIBLE_ASSIGNED',
  'EFFECTIVE_DEADLINE_CHANGED',
  'THIRD_PARTY_DEADLINE_CHANGED',
  'DEFECT_COMPLETED',
  'DEFECT_REOPENED',
  'ATTACHMENT_READY',
  'ATTACHMENT_REJECTED',
  'ATTACHMENT_SCAN_FAILED',
  'SLA_WARNING',
  'SLA_DUE_TODAY',
  'SLA_OVERDUE',
  'ACT_CHAT_MENTION',
  'ORGANIZATION_DETAILS_INCOMPLETE',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const OUTBOX_STATUSES = ['PENDING', 'CLAIMED', 'PROCESSED', 'FAILED', 'DEAD'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const EMAIL_DELIVERY_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'DEAD'] as const;
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];

export const ACT_FORM_DISPLAY: Record<ActFormCode, { code: ActFormCode; officialLabel: string }> = {
  S1: { code: 'S1', officialLabel: 'С-1' },
  S23: { code: 'S23', officialLabel: 'С-23' },
};

export const ATTACHMENT_STATUSES = [
  'UPLOADING',
  'PENDING_SCAN',
  'SCANNING',
  'READY',
  'REJECTED',
  'SCAN_FAILED',
  'ARCHIVED',
] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

export const ATTACHMENT_CATEGORIES = [
  'ACT_DOCUMENT',
  'ACT_SCAN',
  'DEFECT_PHOTO',
  'CLAIM_DOCUMENT',
  'THIRD_PARTY_DOCUMENT',
  'PROPOSAL_DOCUMENT',
  'OTHER',
] as const;
export type AttachmentCategory = (typeof ATTACHMENT_CATEGORIES)[number];

export const ATTACHMENT_OWNER_TYPES = ['ACT', 'DEFECT_ITEM', 'PROPOSAL'] as const;
export type AttachmentOwnerType = (typeof ATTACHMENT_OWNER_TYPES)[number];
