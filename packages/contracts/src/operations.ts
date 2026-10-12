import { z } from 'zod';
import {
  OPERATIONAL_ASSIGNABLE_ROLES,
  ORGANIZATION_ROLES,
  USERS_LIST_ROLE_FILTERS,
  USER_STATUSES,
} from './enums';

const uuid = z.uuid();
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimalAmount = z.string().regex(/^\d+(\.\d{1,2})?$/);

export const expectedVersionSchema = z.number().int().positive();

export const createUserRequestSchema = z
  .object({
    lastName: z.string(),
    firstName: z.string(),
    middleName: z.union([z.string(), z.null()]).optional(),
    email: z.string(),
    role: z.enum(OPERATIONAL_ASSIGNABLE_ROLES),
  })
  .strict();

export const patchUserRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    role: z.enum(OPERATIONAL_ASSIGNABLE_ROLES).optional(),
  })
  .strict();

export const patchUserProfileRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    firstName: z.string(),
    lastName: z.string(),
    middleName: z.union([z.string(), z.null()]).optional(),
    email: z.string(),
    currentPassword: z.string().min(1).max(128).optional(),
  })
  .strict();

export const completeOwnProfileRequestSchema = z
  .object({
    lastName: z.string(),
    firstName: z.string(),
    middleName: z.union([z.string(), z.null()]).optional(),
    phone: z.string(),
    birthDate: calendarDate,
  })
  .strict();

export const patchUserEmploymentRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    hiredOn: z.union([calendarDate, z.null()]),
    contractEndsOn: z.union([calendarDate, z.null()]),
  })
  .strict();

export const versionedReasonSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    reason: z.string().optional(),
  })
  .strict();

export const usersListQuerySchema = z
  .object({
    search: z.string().optional(),
    role: z.enum(USERS_LIST_ROLE_FILTERS).optional(),
    status: z.enum(USER_STATUSES).optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
  })
  .strict();

export const referenceListQuerySchema = z
  .object({
    search: z.string().optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
    sortBy: z.string().optional(),
    sortDirection: z.enum(['asc', 'desc']).optional(),
  })
  .strict();

export const propertyObjectWriteSchema = z
  .object({
    expectedVersion: expectedVersionSchema.optional(),
    name: z.string(),
    address: z.union([z.string(), z.null()]).optional(),
    commissionedAt: z.union([calendarDate, z.null()]).optional(),
    warrantyEndsAt: z.union([calendarDate, z.null()]).optional(),
    responsibleEngineerIds: z.array(uuid).optional(),
  })
  .strict();

export const organizationWriteSchema = z
  .object({
    expectedVersion: expectedVersionSchema.optional(),
    officialName: z.string(),
    unp: z.union([z.string(), z.null()]).optional(),
    postalAddress: z.union([z.string(), z.null()]).optional(),
    email: z.union([z.string(), z.null()]).optional(),
    phone: z.union([z.string(), z.null()]).optional(),
    contactPerson: z.union([z.string(), z.null()]).optional(),
    roles: z.array(z.enum(ORGANIZATION_ROLES)).optional(),
  })
  .strict();

export const constructionWorkProfileWriteSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    workSupplierOnObject: z.union([z.string(), z.null()]),
    workExecution: z.union([z.string(), z.null()]),
  })
  .strict();

export const codedReferenceWriteSchema = z
  .object({
    expectedVersion: expectedVersionSchema.optional(),
    code: z.string().optional(),
    name: z.string(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const createActDefectItemSchema = z
  .object({
    location: z.string(),
    defectTypeId: uuid,
    workTypeId: z.union([uuid, z.null()]).optional(),
    claimDetails: z.string(),
    notes: z.union([z.string(), z.null()]).optional(),
    responsibleEngineerIds: z.array(uuid),
    liableOrganizationIds: z.array(uuid),
    plannedDeadline: z.union([calendarDate, z.null()]).optional(),
    claimDeadline: z.union([calendarDate, z.null()]).optional(),
    thirdPartyDeadline: z.union([calendarDate, z.null()]).optional(),
  })
  .strict();

export const createActRequestSchema = z
  .object({
    formCode: z.enum(['S1', 'S23']),
    objectId: uuid,
    customerOrganizationId: uuid,
    issuedOn: calendarDate,
    signedDocumentRef: z.union([z.string(), z.null()]).optional(),
    defectItems: z.array(createActDefectItemSchema).min(1),
  })
  .strict();

export const patchActHeaderRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    objectId: uuid.optional(),
    customerOrganizationId: uuid.optional(),
    issuedOn: calendarDate.optional(),
    signedDocumentRef: z.union([z.string(), z.null()]).optional(),
  })
  .strict();

export const addDefectRequestSchema = createActDefectItemSchema.extend({
  expectedActVersion: expectedVersionSchema,
});

export const resolveImportedEngineerRequestSchema = z
  .object({
    userId: uuid,
  })
  .strict();

export const replaceAssignmentsRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    responsibleEngineerIds: z.array(uuid),
    liableOrganizationIds: z.array(uuid),
    confirmRemoveLastEngineer: z.boolean().optional(),
  })
  .strict();

export const patchDeadlinesRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    plannedDeadline: z.union([calendarDate, z.null()]).optional(),
    claimDeadline: z.union([calendarDate, z.null()]).optional(),
    thirdPartyDeadline: z.union([calendarDate, z.null()]).optional(),
    reason: z.string().optional(),
    confirmCompletedEdit: z.boolean().optional(),
  })
  .strict();

export const completeDefectRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    readyAt: calendarDate.optional(),
    comment: z.string().optional(),
  })
  .strict();

export const cancelActRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    reason: z.string(),
  })
  .strict();

export const reopenDefectRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    reason: z.string(),
  })
  .strict();

export const submitDefectForInspectionRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    comment: z.string(),
  })
  .strict();

export const acceptDefectRepairRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
  })
  .strict();

export const rejectDefectRepairRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    reason: z.string(),
  })
  .strict();

export const assignOrganizationMembershipRequestSchema = z
  .object({
    organizationId: uuid,
  })
  .strict();

export const upsertProposalRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema.optional(),
    amount: decimalAmount,
    alternativeContractorOrganizationId: uuid,
  })
  .strict();

export const archiveProposalRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    reason: z.string(),
  })
  .strict();

export const restoreProposalRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
  })
  .strict();

export const startActRequestSchema = z.object({}).strict();

export const historyQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  })
  .strict();

const auditEntityTypes = [
  'USER',
  'ACT',
  'DEFECT_ITEM',
  'PROPOSAL',
  'ATTACHMENT',
  'PROPERTY_OBJECT',
  'ORGANIZATION',
  'WORK_TYPE',
  'DEFECT_TYPE',
  'NOTIFICATION',
] as const;

export const auditLogQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
    search: z.string().max(200).optional(),
    actorUserId: uuid.optional(),
    action: z.string().max(80).optional(),
    entityType: z.enum(auditEntityTypes).optional(),
    entityId: uuid.optional(),
    from: calendarDate.optional(),
    to: calendarDate.optional(),
  })
  .strict();

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export interface AuditLogListItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  parentEntityType: string | null;
  parentEntityId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorLastName: string | null;
  actorFirstName: string | null;
  actorMiddleName: string | null;
  occurredAt: string;
}

export interface AuditLogListResponse {
  items: AuditLogListItem[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  nextCursor: string | null;
}

export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;
export type PatchUserRequest = z.infer<typeof patchUserRequestSchema>;
export type PatchUserProfileRequest = z.infer<typeof patchUserProfileRequestSchema>;
export type CreateActRequest = z.infer<typeof createActRequestSchema>;
export type PatchActHeaderRequest = z.infer<typeof patchActHeaderRequestSchema>;
export type AddDefectRequest = z.infer<typeof addDefectRequestSchema>;
export type ReplaceAssignmentsRequest = z.infer<typeof replaceAssignmentsRequestSchema>;
export type PatchDeadlinesRequest = z.infer<typeof patchDeadlinesRequestSchema>;
export type CompleteDefectRequest = z.infer<typeof completeDefectRequestSchema>;
export type ReopenDefectRequest = z.infer<typeof reopenDefectRequestSchema>;
export type UpsertProposalRequest = z.infer<typeof upsertProposalRequestSchema>;
export type RestoreProposalRequest = z.infer<typeof restoreProposalRequestSchema>;
export type StartActRequest = z.infer<typeof startActRequestSchema>;
