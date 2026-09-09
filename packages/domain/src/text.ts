import { ValidationError } from './errors';

export function normalizeUnicode(value: string): string {
  return value.normalize('NFC');
}

export function foldKey(value: string): string {
  return normalizeUnicode(value).trim().toLocaleLowerCase('ru');
}

const MATCH_QUOTES = /[«»„“”"'`]/g;
const MATCH_DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;

export function foldMatchKey(value: string): string {
  return value
    .normalize('NFKC')
    .replaceAll('\u0451', '\u0435')
    .replaceAll('\u0401', '\u0415')
    .replace(MATCH_QUOTES, '"')
    .replace(MATCH_DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('ru');
}

export function normalizeRequiredText(
  value: unknown,
  field: string,
  maxLength: number,
  minLength = 1,
): string {
  if (typeof value !== 'string') {
    throw new ValidationError(field, 'Значение обязательно');
  }
  const normalized = normalizeUnicode(value).trim();
  if (normalized.length < minLength) {
    throw new ValidationError(field, 'Значение обязательно');
  }
  if (normalized.length > maxLength) {
    throw new ValidationError(field, `Максимальная длина — ${maxLength} символов`);
  }
  return normalized;
}

export function normalizeOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ValidationError(field, 'Некорректное значение');
  }
  const normalized = normalizeUnicode(value).trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > maxLength) {
    throw new ValidationError(field, `Максимальная длина — ${maxLength} символов`);
  }
  return normalized;
}

export function normalizeRequiredReason(value: unknown, minLength = 3, maxLength = 500): string {
  return normalizeRequiredText(value, 'reason', maxLength, minLength);
}
