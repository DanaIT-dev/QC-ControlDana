import type { UserRole } from '@sgr-registry/contracts';

export interface AuthenticatedUser {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  sessionVersion: number;
  sessionHash: string;
  csrfToken: string;
  mustChangePassword: boolean;
}
