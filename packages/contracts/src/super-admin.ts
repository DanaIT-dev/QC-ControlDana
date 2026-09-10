import { z } from 'zod';
import { expectedVersionSchema } from './operations';
import type { UserRole, UserStatus } from './enums';

export const superAdminDirectoryQuerySchema = z
  .object({
    search: z.string().max(200).optional(),
  })
  .strict();

export const adminGrantRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
  })
  .strict();

export const createUnassignedUserRequestSchema = z
  .object({
    lastName: z.string(),
    firstName: z.string(),
    middleName: z.union([z.string(), z.null()]).optional(),
    email: z.string(),
  })
  .strict();

export type SuperAdminDirectoryQuery = z.infer<typeof superAdminDirectoryQuerySchema>;
export type AdminGrantRequest = z.infer<typeof adminGrantRequestSchema>;
export type CreateUnassignedUserRequest = z.infer<typeof createUnassignedUserRequestSchema>;

export type SuperAdminUserAdminStatus = 'ACTIVE_ADMIN' | 'ELIGIBLE';

export interface SuperAdminDirectoryUser {
  id: string;
  fullName: string;
  email: string;
  currentRole: UserRole;
  roleLabel: string;
  adminStatus: SuperAdminUserAdminStatus;
  status: UserStatus;
  archivedAt: string | null;
  version: number;
}

export interface SuperAdminDirectoryResponse {
  items: SuperAdminDirectoryUser[];
}
