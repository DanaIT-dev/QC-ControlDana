import type { UserRole } from '@sgr-registry/contracts';

export interface AuthenticatedUser {
  id: string;
  lastName?: string;
  firstName?: string;
  middleName?: string | null;
  fullName: string;
  email: string;
  role: UserRole;
  sessionVersion: number;
  sessionHash: string;
  csrfToken: string;
  mustChangePassword: boolean;
}
