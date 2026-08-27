import { LastAdminProtectedError, SelfArchiveError, ValidationError } from './errors';
import { normalizeEmail, isValidEmail } from './email';
import { normalizeRequiredText } from './text';
import type { UserRole, UserStatus } from '@sgr-registry/contracts';

export const USER_FULL_NAME_MAX = 200;

export function normalizeUserFullName(value: unknown): string {
  return normalizeRequiredText(value, 'fullName', USER_FULL_NAME_MAX);
}

export function normalizeUserEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('email', 'Укажите электронную почту');
  }
  const email = normalizeEmail(value);
  if (!isValidEmail(email)) {
    throw new ValidationError('email', 'Некорректный адрес электронной почты');
  }
  return email;
}

export function assertNotSelfArchive(actorUserId: string, targetUserId: string): void {
  if (actorUserId === targetUserId) {
    throw new SelfArchiveError();
  }
}

export function assertLastActiveAdminProtected(input: {
  targetUserId: string;
  targetRole: UserRole;
  nextRole?: UserRole;
  nextStatus?: UserStatus;
  activeAdminCount: number;
}): void {
  const remainsAdmin = (input.nextRole ?? input.targetRole) === 'ADMIN';
  const remainsActive = (input.nextStatus ?? 'ACTIVE') === 'ACTIVE';
  const demotingOrArchiving = !(remainsAdmin && remainsActive);
  if (input.targetRole === 'ADMIN' && demotingOrArchiving && input.activeAdminCount <= 1) {
    throw new LastAdminProtectedError();
  }
}

export const ASSIGNABLE_ENGINEER_ROLE = 'RESPONSIBLE_ENGINEER' as const;
