import { ValidationError } from './errors';

export const PERSON_NAME_PART_MAX = 80;
export const PERSON_FULL_NAME_MAX = 200;
const NAME_PART_PATTERN =
  /^[\p{L}]+(?:[\u0027\u2019\u02BC][\p{L}]+)?(?:-[\p{L}]+(?:[\u0027\u2019\u02BC][\p{L}]+)?)?$/u;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

export type PersonNameParts = {
  lastName: string;
  firstName: string;
  middleName: string | null;
};

export function normalizePersonNamePart(
  value: unknown,
  field: 'lastName' | 'firstName' | 'middleName',
  required: boolean,
): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new ValidationError(field, 'Значение обязательно');
    }
    return null;
  }
  if (typeof value !== 'string') {
    throw new ValidationError(field, 'Некорректное значение');
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) {
    if (required) {
      throw new ValidationError(field, 'Значение обязательно');
    }
    return null;
  }
  if (CONTROL_OR_FORMAT.test(normalized)) {
    throw new ValidationError(field, 'Недопустимые символы');
  }
  if (normalized.includes(' ')) {
    throw new ValidationError(field, 'Укажите одно слово без пробелов');
  }
  if (normalized.length > PERSON_NAME_PART_MAX) {
    throw new ValidationError(field, `Максимальная длина — ${PERSON_NAME_PART_MAX} символов`);
  }
  if (!NAME_PART_PATTERN.test(normalized)) {
    throw new ValidationError(field, 'Допустимы буквы, дефис и апостроф');
  }
  return normalized;
}

export function composeOfficialFullName(parts: PersonNameParts): string {
  const tokens = [parts.lastName, parts.firstName, parts.middleName].filter(
    (item): item is string => Boolean(item),
  );
  const fullName = tokens.join(' ');
  if (fullName.length === 0 || fullName.length > PERSON_FULL_NAME_MAX) {
    throw new ValidationError('fullName', 'Некорректное ФИО');
  }
  return fullName;
}

export function parsePersonNameInput(input: {
  lastName: unknown;
  firstName: unknown;
  middleName: unknown;
}): PersonNameParts {
  const lastName = normalizePersonNamePart(input.lastName, 'lastName', true);
  const firstName = normalizePersonNamePart(input.firstName, 'firstName', true);
  const middleName = normalizePersonNamePart(input.middleName, 'middleName', false);
  if (!lastName || !firstName) {
    throw new ValidationError('lastName', 'Значение обязательно');
  }
  return { lastName, firstName, middleName };
}

export function parsePersonNameForForm(fullName: string): PersonNameParts {
  const display = fullName.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const tokens = display.length === 0 ? [] : display.split(' ');
  if (
    tokens.length >= 2 &&
    tokens.length <= 3 &&
    tokens.every((token) => NAME_PART_PATTERN.test(token) && !CONTROL_OR_FORMAT.test(token))
  ) {
    return {
      lastName: tokens[0]!,
      firstName: tokens[1]!,
      middleName: tokens[2] ?? null,
    };
  }
  return {
    lastName: display,
    firstName: '',
    middleName: null,
  };
}
