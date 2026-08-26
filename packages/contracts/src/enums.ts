export const ACT_FORM_CODES = ['S1', 'S23'] as const;
export type ActFormCode = (typeof ACT_FORM_CODES)[number];

export const ACT_STATUSES = ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type ActStatus = (typeof ACT_STATUSES)[number];

export const DEFECT_ITEM_STATUSES = ['IN_PROGRESS', 'COMPLETED'] as const;
export type DefectItemStatus = (typeof DEFECT_ITEM_STATUSES)[number];

export const USER_ROLES = [
  'ADMIN',
  'SGR_MANAGER',
  'RESPONSIBLE_ENGINEER',
  'CONTRACTOR_ENGINEER',
] as const;
export type UserRole = (typeof USER_ROLES)[number];

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

export const ACT_FORM_DISPLAY: Record<ActFormCode, { code: ActFormCode; officialLabel: string }> = {
  S1: { code: 'S1', officialLabel: 'С-1' },
  S23: { code: 'S23', officialLabel: 'С-23' },
};
