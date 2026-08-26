export const AUTH_LOGIN_FAILED_MESSAGE = 'Неверный логин или пароль';
export const AUTH_RATE_LIMITED_MESSAGE = 'Слишком много попыток входа. Попробуйте позже.';
export const SESSION_COOKIE_NAME = 'sgr_session';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export const AUTH_AUDIT_ACTIONS = [
  'LOGIN_SUCCEEDED',
  'LOGIN_FAILED',
  'LOGIN_RATE_LIMITED',
  'LOGOUT',
  'LOGOUT_ALL',
  'SESSION_REJECTED_ARCHIVED_USER',
  'SESSION_REJECTED_VERSION_MISMATCH',
] as const;

export type AuthAuditAction = (typeof AUTH_AUDIT_ACTIONS)[number];
