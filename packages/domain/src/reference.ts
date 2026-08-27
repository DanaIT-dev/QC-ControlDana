import { DuplicateValueError, ValidationError } from './errors';
import { foldKey, normalizeOptionalText, normalizeRequiredText } from './text';
import { normalizeUnp } from './unp';

export const REFERENCE_NAME_MAX = 200;
export const REFERENCE_ADDRESS_MAX = 300;
export const REFERENCE_CODE_MAX = 40;
export const ORGANIZATION_CONTACT_MAX = 200;

export function normalizeReferenceName(value: unknown, field = 'name'): string {
  return normalizeRequiredText(value, field, REFERENCE_NAME_MAX);
}

export function normalizeReferenceCode(value: unknown): string {
  const code = normalizeRequiredText(value, 'code', REFERENCE_CODE_MAX);
  return code.toUpperCase();
}

export function assertCaseInsensitiveUnique(
  candidate: string,
  existing: readonly string[],
  message = 'Такое значение уже существует',
): void {
  const folded = foldKey(candidate);
  if (existing.some((item) => foldKey(item) === folded)) {
    throw new DuplicateValueError(message);
  }
}

export function parseOptionalCalendarDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(field, 'Ожидается дата в формате ГГГГ-ММ-ДД');
  }
  return value;
}

export function parseRequiredCalendarDate(value: unknown, field: string): string {
  const parsed = parseOptionalCalendarDate(value, field);
  if (!parsed) {
    throw new ValidationError(field, 'Дата обязательна');
  }
  return parsed;
}

export function normalizeOrganizationUnp(value: unknown): string | null {
  if (typeof value !== 'string' && value !== null && value !== undefined) {
    throw new ValidationError('unp', 'Некорректный УНП');
  }
  return normalizeUnp(typeof value === 'string' ? value : null);
}

export function normalizeContact(value: unknown, field: string): string {
  return normalizeRequiredText(value, field, ORGANIZATION_CONTACT_MAX);
}

export function normalizeOptionalContact(value: unknown, field: string): string | null {
  return normalizeOptionalText(value, field, ORGANIZATION_CONTACT_MAX);
}
