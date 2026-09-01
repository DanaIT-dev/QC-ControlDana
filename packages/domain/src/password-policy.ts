import { DomainError } from './errors';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_POLICY_HINT = `Минимум ${PASSWORD_MIN_LENGTH} символов`;

export class PasswordPolicyError extends DomainError {
  constructor(message: string) {
    super('PASSWORD_POLICY', message);
    this.name = 'PasswordPolicyError';
  }
}

export type PasswordPolicyContext = {
  email?: string;
  fullName?: string;
};

const LENGTH_MESSAGE = `Пароль должен содержать от ${PASSWORD_MIN_LENGTH} до ${PASSWORD_MAX_LENGTH} символов`;
const SPACE_EDGE_MESSAGE = 'Пароль не должен начинаться или заканчиваться пробелом';
const BLANK_MESSAGE = 'Пароль не должен состоять только из пробелов';
const WEAK_MESSAGE = 'Пароль слишком простой или совпадает с данными учётки';

const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password12',
  'password123',
  'qwerty',
  'qwerty12',
  'qwerty123',
  'qwertyui',
  'qwertyuiop',
  '12345678',
  '123456789',
  '1234567890',
  'admin123',
  'admin1234',
  'letmein1',
  'welcome1',
  'passw0rd',
  'iloveyou',
  '1q2w3e4r',
  'qazwsxed',
  'abc12345',
  'abcdefgh',
  'пароль12',
  'йцукенгш',
]);

const SEQUENCE_ROWS = [
  '0123456789',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiopasdfghjklzxcvbnm',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'йцукенгшщзхъфывапролджэячсмитьбю',
  'йцукенгшщзхъ',
  'фывапролджэ',
  'ячсмитьбю',
  'абвгдеёжзийклмнопрстуфхцчшщъыьэюя',
  'абвгдежзийклмнопрстуфхцчшщъыьэюя',
];

function foldCopy(value: string): string {
  return value.toLowerCase();
}

function isBlankPassword(password: string): boolean {
  return password.length > 0 && password.trim().length === 0;
}

function hasEdgeWhitespace(password: string): boolean {
  return password.length > 0 && password !== password.trim();
}

function hasEightIdenticalCharacters(password: string): boolean {
  return /(.)\1{7,}/u.test(password);
}

function isMonotonicRun(value: string): boolean {
  if (value.length < PASSWORD_MIN_LENGTH) {
    return false;
  }
  let ascending = true;
  let descending = true;
  for (let index = 1; index < value.length; index += 1) {
    const delta = value.charCodeAt(index) - value.charCodeAt(index - 1);
    if (delta !== 1) {
      ascending = false;
    }
    if (delta !== -1) {
      descending = false;
    }
    if (!ascending && !descending) {
      return false;
    }
  }
  return ascending || descending;
}

function isListedSequence(value: string): boolean {
  const folded = foldCopy(value);
  const reversed = [...folded].reverse().join('');
  return SEQUENCE_ROWS.some((row) => {
    const haystacks = [row, [...row].reverse().join('')];
    return haystacks.some((haystack) => haystack.includes(folded) || haystack.includes(reversed));
  });
}

function hasObviousSequence(password: string): boolean {
  const folded = foldCopy(password);
  if (folded.length < PASSWORD_MIN_LENGTH) {
    return false;
  }
  for (let start = 0; start <= folded.length - PASSWORD_MIN_LENGTH; start += 1) {
    const slice = folded.slice(start, start + PASSWORD_MIN_LENGTH);
    if (isListedSequence(slice) || isMonotonicRun(slice)) {
      return true;
    }
  }
  return false;
}

function identityFragments(context: PasswordPolicyContext): string[] {
  const fragments = new Set<string>();
  const email = context.email?.trim();
  if (email) {
    const foldedEmail = foldCopy(email);
    fragments.add(foldedEmail);
    const localPart = foldedEmail.split('@')[0] ?? '';
    if (localPart.length >= 3) {
      fragments.add(localPart);
    }
    for (const token of localPart.split(/[._+-]+/)) {
      if (token.length >= 4) {
        fragments.add(token);
      }
    }
  }
  const fullName = context.fullName?.trim();
  if (fullName) {
    const foldedName = foldCopy(fullName);
    fragments.add(foldedName);
    fragments.add(foldedName.replace(/\s+/g, ''));
    for (const token of foldedName.split(/[\s_.-]+/u)) {
      if (token.length >= 4) {
        fragments.add(token);
      }
    }
  }
  return [...fragments].filter((fragment) => fragment.length > 0);
}

function matchesIdentity(password: string, context: PasswordPolicyContext): boolean {
  const folded = foldCopy(password);
  const compact = folded.replace(/\s+/g, '');
  for (const fragment of identityFragments(context)) {
    const compactFragment = fragment.replace(/\s+/g, '');
    if (folded === fragment || compact === compactFragment) {
      return true;
    }
    if (fragment.length >= 4 && (folded.includes(fragment) || compact.includes(compactFragment))) {
      return true;
    }
  }
  return false;
}

export function assertPasswordPolicy(password: string, context: PasswordPolicyContext = {}): void {
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new PasswordPolicyError(LENGTH_MESSAGE);
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new PasswordPolicyError(LENGTH_MESSAGE);
  }
  if (isBlankPassword(password)) {
    throw new PasswordPolicyError(BLANK_MESSAGE);
  }
  if (hasEdgeWhitespace(password)) {
    throw new PasswordPolicyError(SPACE_EDGE_MESSAGE);
  }
  if (hasEightIdenticalCharacters(password)) {
    throw new PasswordPolicyError(WEAK_MESSAGE);
  }
  if (COMMON_PASSWORDS.has(foldCopy(password))) {
    throw new PasswordPolicyError(WEAK_MESSAGE);
  }
  if (hasObviousSequence(password)) {
    throw new PasswordPolicyError(WEAK_MESSAGE);
  }
  if (matchesIdentity(password, context)) {
    throw new PasswordPolicyError(WEAK_MESSAGE);
  }
}

export function isPasswordPolicySatisfied(
  password: string,
  context: PasswordPolicyContext = {},
): boolean {
  try {
    assertPasswordPolicy(password, context);
    return true;
  } catch {
    return false;
  }
}
