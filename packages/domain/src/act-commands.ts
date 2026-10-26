import { ValidationError } from './errors';
import { normalizeOptionalText, normalizeRequiredText } from './text';
import { parseRequiredCalendarDate, parseOptionalCalendarDate } from './reference';

export const ACT_CREATE_MIN_DEFECTS = 1;
export const LOCATION_MAX = 200;
export const CLAIM_DETAILS_MAX = 2000;
export const NOTES_MAX = 2000;
export const DOCUMENT_REF_MAX = 500;

export function normalizeLocation(value: unknown): string {
  return normalizeRequiredText(value, 'location', LOCATION_MAX);
}

export function normalizeClaimDetails(value: unknown): string {
  return normalizeRequiredText(value, 'claimDetails', CLAIM_DETAILS_MAX);
}

export function normalizeNotes(value: unknown): string | null {
  return normalizeOptionalText(value, 'notes', NOTES_MAX);
}

export const DOCUMENT_LINK_INVALID =
  'Не удалось сохранить ссылку. Проверьте адрес и повторите попытку.';

const DOCUMENT_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function normalizeDocumentRef(value: unknown): string | null {
  const text = normalizeOptionalText(value, 'signedDocumentRef', DOCUMENT_REF_MAX);
  if (text === null) {
    return null;
  }
  if (!DOCUMENT_SCHEME.test(text)) {
    return text;
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new ValidationError('signedDocumentRef', DOCUMENT_LINK_INVALID);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new ValidationError('signedDocumentRef', DOCUMENT_LINK_INVALID);
  }
  return text;
}

export function parseActIssuedOn(value: unknown): string {
  return parseRequiredCalendarDate(value, 'issuedOn');
}

export function parseOptionalDeadline(value: unknown, field: string): string | null {
  return parseOptionalCalendarDate(value, field);
}

export function assertUniqueIds(ids: readonly string[], field: string): string[] {
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) {
    throw new ValidationError(field, 'Нельзя добавить одно и то же значение дважды');
  }
  return unique;
}

export function assertAtLeastOneDefectItem(count: number): void {
  if (count < ACT_CREATE_MIN_DEFECTS) {
    throw new ValidationError('defectItems', 'Акт должен содержать хотя бы один дефект');
  }
}

export function assertAtLeastOneEngineer(count: number): void {
  if (count < 1) {
    throw new ValidationError(
      'responsibleEngineerIds',
      'Назначьте хотя бы одного ответственного инженера',
    );
  }
}
