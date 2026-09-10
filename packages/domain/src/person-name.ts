import { ValidationError } from './errors';

export const PERSON_NAME_PART_MAX = 80;
export const PERSON_FULL_NAME_MAX = 200;
const NAME_PART_PATTERN =
  /^[\p{L}]+(?:[\u0027\u2019\u02BC][\p{L}]+)?(?:-[\p{L}]+(?:[\u0027\u2019\u02BC][\p{L}]+)?)?$/u;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const SURNAME_INITIALS_TAIL = /^[\p{L}](?:\.[\p{L}])?\.?$/u;

export type PersonNameParts = {
  lastName: string;
  firstName: string;
  middleName: string | null;
};

export type StoredOfficialPersonNameParse =
  { ok: true; parts: PersonNameParts } | { ok: false; reason: string };

export const CONFIRMED_LAST_FIRST_TOKEN_ORDER = {
  confirmTokenOrder: 'last-first',
} as const;

export type PersonNameWriteConfirmation =
  | typeof CONFIRMED_LAST_FIRST_TOKEN_ORDER
  | { confirmTwoToken: { lastName: string; firstName: string } };

const PATRONYMIC_PATTERN = /(?:ович|евич|ёвич|ивич|овна|евна|ична|инична)$/iu;

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

function firstUnicodeLetter(value: string): string {
  for (const char of value) {
    if (/\p{L}/u.test(char)) {
      return char.toLocaleUpperCase('ru');
    }
  }
  return '';
}

function looksLikeSurnameInitials(value: string): boolean {
  const display = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const separator = display.indexOf(' ');
  if (separator <= 0) {
    return false;
  }
  const surname = display.slice(0, separator);
  const tail = display.slice(separator + 1).trim();
  return NAME_PART_PATTERN.test(surname) && SURNAME_INITIALS_TAIL.test(tail);
}

function personNamePartsFromInput(input: PersonNameParts | string): PersonNameParts {
  if (typeof input !== 'string') {
    return input;
  }
  const official = parseStoredOfficialPersonName(input);
  if (official.ok) {
    return official.parts;
  }
  return parsePersonNameForForm(input);
}

export function formatPersonFull(input: PersonNameParts | string): string {
  const parts = personNamePartsFromInput(input);
  return [parts.lastName, parts.firstName, parts.middleName]
    .map((item) => item?.trim() ?? '')
    .filter((item) => item.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatPersonShort(input: PersonNameParts | string): string {
  if (typeof input === 'string' && looksLikeSurnameInitials(input)) {
    const display = input.normalize('NFKC').trim().replace(/\s+/g, ' ');
    const separator = display.indexOf(' ');
    const surname = display.slice(0, separator);
    const tail = display
      .slice(separator + 1)
      .trim()
      .replaceAll(' ', '');
    const letters = [...tail].filter((char) => /\p{L}/u.test(char));
    if (letters.length === 1) {
      return `${surname} ${letters[0]!.toLocaleUpperCase('ru')}.`;
    }
    if (letters.length === 2) {
      return `${surname} ${letters[0]!.toLocaleUpperCase('ru')}.${letters[1]!.toLocaleUpperCase('ru')}.`;
    }
    return display;
  }
  const parts = personNamePartsFromInput(input);
  const lastName = parts.lastName.trim();
  if (!lastName) {
    return '';
  }
  const firstInitial = firstUnicodeLetter(parts.firstName.trim());
  if (!firstInitial) {
    return lastName;
  }
  const middleInitial = firstUnicodeLetter(parts.middleName?.trim() ?? '');
  if (!middleInitial) {
    return `${lastName} ${firstInitial}.`;
  }
  return `${lastName} ${firstInitial}.${middleInitial}.`;
}

export function composeOfficialFullName(parts: PersonNameParts): string {
  const fullName = formatPersonFull(parts);
  if (fullName.length === 0 || fullName.length > PERSON_FULL_NAME_MAX) {
    throw new ValidationError('fullName', 'Некорректное ФИО');
  }
  return fullName;
}

export function resolveOfficialFullName(input: {
  fullName?: string | null;
  lastName?: string | null;
  firstName?: string | null;
  middleName?: string | null;
}): string {
  if (input.lastName != null || input.firstName != null) {
    return composeOfficialFullName(
      parsePersonNameInput({
        lastName: input.lastName,
        firstName: input.firstName,
        middleName: input.middleName ?? null,
      }),
    );
  }
  const display =
    typeof input.fullName === 'string'
      ? input.fullName.normalize('NFKC').trim().replace(/\s+/g, ' ')
      : '';
  if (!display) {
    throw new ValidationError('lastName', 'Значение обязательно');
  }
  if (display.length > PERSON_FULL_NAME_MAX) {
    throw new ValidationError('fullName', 'Некорректное ФИО');
  }
  return display;
}

export function foldPersonSearchKey(value: string): string {
  return value
    .normalize('NFKC')
    .replaceAll('\u0451', '\u0435')
    .replaceAll('\u0401', '\u0415')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('ru');
}

export function personMatchesSearch(fullName: string, query: string): boolean {
  const needle = foldPersonSearchKey(query);
  if (!needle) {
    return false;
  }
  const parts = parsePersonNameForForm(fullName);
  const haystacks = [
    fullName,
    formatPersonFull(parts),
    formatPersonShort(parts),
    formatPersonShort({ ...parts, middleName: null }),
    parts.lastName,
    parts.firstName,
    parts.middleName ?? '',
    `${parts.lastName} ${firstUnicodeLetter(parts.firstName)}`,
    `${parts.lastName} ${firstUnicodeLetter(parts.firstName)}.`,
  ];
  return haystacks.some((item) => foldPersonSearchKey(item).includes(needle));
}

export function comparePersonNames(left: PersonNameParts, right: PersonNameParts): number {
  const last = left.lastName.localeCompare(right.lastName, 'ru', { sensitivity: 'base' });
  if (last !== 0) {
    return last;
  }
  const first = left.firstName.localeCompare(right.firstName, 'ru', { sensitivity: 'base' });
  if (first !== 0) {
    return first;
  }
  return (left.middleName ?? '').localeCompare(right.middleName ?? '', 'ru', {
    sensitivity: 'base',
  });
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

export function isPatronymicNamePart(value: string): boolean {
  return PATRONYMIC_PATTERN.test(value.normalize('NFKC').trim());
}

export function parseStoredOfficialPersonName(fullName: string): StoredOfficialPersonNameParse {
  const display = fullName.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!display) {
    return { ok: false, reason: 'пустое ФИО' };
  }
  const tokens = display.split(' ');
  if (tokens.some((token) => !NAME_PART_PATTERN.test(token) || CONTROL_OR_FORMAT.test(token))) {
    return { ok: false, reason: 'небезопасные токены' };
  }
  if (tokens.length === 2) {
    return {
      ok: false,
      reason: 'двухсловное ФИО требует подтверждения структуры',
    };
  }
  if (tokens.length === 3) {
    if (!isPatronymicNamePart(tokens[2]!)) {
      return { ok: false, reason: 'третье слово не подтверждено как отчество' };
    }
    return {
      ok: true,
      parts: { lastName: tokens[0]!, firstName: tokens[1]!, middleName: tokens[2]! },
    };
  }
  return { ok: false, reason: `неоднозначное число слов: ${tokens.length}` };
}

export function confirmTwoTokenOfficialName(
  fullName: string,
  mapping: { lastName: string; firstName: string },
): PersonNameParts {
  const display = fullName.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const tokens = display.split(' ');
  if (tokens.length !== 2) {
    throw new ValidationError('fullName', 'Подтверждение только для двухсловного ФИО');
  }
  const lastName = normalizePersonNamePart(mapping.lastName, 'lastName', true);
  const firstName = normalizePersonNamePart(mapping.firstName, 'firstName', true);
  if (!lastName || !firstName) {
    throw new ValidationError('lastName', 'Значение обязательно');
  }
  const tokenKeys = new Set(tokens.map((token) => foldPersonSearchKey(token)));
  const mappedKeys = new Set([foldPersonSearchKey(lastName), foldPersonSearchKey(firstName)]);
  if (
    tokenKeys.size !== 2 ||
    mappedKeys.size !== 2 ||
    [...tokenKeys].some((token) => !mappedKeys.has(token))
  ) {
    throw new ValidationError('fullName', 'Подтверждённые части не совпадают с исходным ФИО');
  }
  return { lastName, firstName, middleName: null };
}

export function personNameFromParts(input: {
  lastName: string;
  firstName: string;
  middleName?: string | null;
}): PersonNameParts & { fullName: string } {
  const parts = parsePersonNameInput({
    lastName: input.lastName,
    firstName: input.firstName,
    middleName: input.middleName ?? null,
  });
  return { ...parts, fullName: composeOfficialFullName(parts) };
}

export function reportAmbiguousLegacyPersonName(fullName: string): string | null {
  const parsed = parseStoredOfficialPersonName(fullName);
  return parsed.ok ? null : parsed.reason;
}

export function personNameWriteFields(
  fullName: string,
  confirmation?: PersonNameWriteConfirmation,
): PersonNameParts & { fullName: string } {
  const parsed = parseStoredOfficialPersonName(fullName);
  if (parsed.ok) {
    return { ...parsed.parts, fullName: formatPersonFull(parsed.parts) };
  }
  if (confirmation && 'confirmTwoToken' in confirmation) {
    const parts = confirmTwoTokenOfficialName(fullName, confirmation.confirmTwoToken);
    return { ...parts, fullName: formatPersonFull(parts) };
  }
  if (confirmation && 'confirmTokenOrder' in confirmation) {
    const display = fullName.normalize('NFKC').trim().replace(/\s+/g, ' ');
    const tokens = display.length === 0 ? [] : display.split(' ');
    if (tokens.length < 2 || tokens.length > 3) {
      throw new ValidationError('fullName', parsed.reason);
    }
    if (tokens.some((token) => CONTROL_OR_FORMAT.test(token) || token.length === 0)) {
      throw new ValidationError('fullName', 'небезопасные токены');
    }
    const parts = {
      lastName: tokens[0]!,
      firstName: tokens[1]!,
      middleName: tokens[2] ?? null,
    };
    return {
      ...parts,
      fullName: [parts.lastName, parts.firstName, parts.middleName]
        .filter((item): item is string => Boolean(item && item.length > 0))
        .join(' '),
    };
  }
  throw new ValidationError('fullName', parsed.reason);
}

export function parsePersonNameForForm(fullName: string): PersonNameParts {
  const display = fullName.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const tokens = display.length === 0 ? [] : display.split(' ');
  if (
    tokens.length === 3 &&
    tokens.every((token) => NAME_PART_PATTERN.test(token) && !CONTROL_OR_FORMAT.test(token)) &&
    isPatronymicNamePart(tokens[2]!)
  ) {
    return {
      lastName: tokens[0]!,
      firstName: tokens[1]!,
      middleName: tokens[2]!,
    };
  }
  return {
    lastName: display,
    firstName: '',
    middleName: null,
  };
}
