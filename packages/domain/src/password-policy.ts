import { DomainError } from './errors';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export class PasswordPolicyError extends DomainError {
  constructor(message: string) {
    super('PASSWORD_POLICY', message);
    this.name = 'PasswordPolicyError';
  }
}

export function assertPasswordPolicy(password: string): void {
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new PasswordPolicyError('Password exceeds the maximum allowed length');
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new PasswordPolicyError('Password does not meet complexity requirements');
  }
  if (
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/\d/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new PasswordPolicyError('Password does not meet complexity requirements');
  }
}

export function isPasswordPolicySatisfied(password: string): boolean {
  try {
    assertPasswordPolicy(password);
    return true;
  } catch {
    return false;
  }
}
