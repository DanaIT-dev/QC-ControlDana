import { z } from 'zod';
import type { UserRole } from './enums';

export const loginRequestSchema = z
  .object({
    email: z.string().min(1).max(254),
    password: z.string().min(1).max(128),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export interface SafeUserProfile {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  roleLabel: string;
  csrfToken: string;
  mustChangePassword: boolean;
}

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(1).max(128),
  })
  .strict();

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export interface CapabilitiesResponse {
  role: UserRole;
  roleLabel: string;
  capabilities: string[];
  capabilityLabels: Record<string, string>;
}
