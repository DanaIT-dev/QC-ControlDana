import { formatPersonShort } from './person-name';

export const ENGINEER_MATCH_RESULTS = ['MATCHED', 'UNMATCHED', 'AMBIGUOUS', 'INVALID'] as const;
export type EngineerMatchResult = (typeof ENGINEER_MATCH_RESULTS)[number];

export const DIRECTORY_ENGINEER_LINK_METHODS = ['AUTO_EXACT', 'ADMIN_CONFIRMED'] as const;
export type DirectoryEngineerLinkMethod = (typeof DIRECTORY_ENGINEER_LINK_METHODS)[number];

export interface EngineerMatchCandidate {
  id?: string;
  fullName: string;
  role: string;
  status: string;
}

export interface EngineerMatchClassification<
  T extends EngineerMatchCandidate = EngineerMatchCandidate,
> {
  result: EngineerMatchResult | 'EMPTY';
  matches: T[];
}

const NAME_WORD = /^[\p{L}]+(?:-[\p{L}]+)?$/u;
const INITIALS_LETTERS = /^[\p{L}]{1,2}$/u;

export function foldEngineerKey(value: string): string {
  return value
    .normalize('NFKC')
    .replaceAll('\u0451', '\u0435')
    .replaceAll('\u0401', '\u0415')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('ru');
}

export function formatAccountAsInitials(fullName: string): string | null {
  const short = formatPersonShort(fullName);
  return short.length > 0 ? short : null;
}

export function parseSourceSurnameInitials(
  value: string,
): { surname: string; firstInitial: string; patronymicInitial: string | null } | null {
  const folded = foldEngineerKey(value);
  const separator = folded.indexOf(' ');
  if (separator <= 0) {
    return null;
  }
  const surname = folded.slice(0, separator);
  const tail = folded
    .slice(separator + 1)
    .replaceAll('.', '')
    .replaceAll(' ', '');
  if (!INITIALS_LETTERS.test(tail)) {
    return null;
  }
  return {
    surname,
    firstInitial: tail.charAt(0),
    patronymicInitial: tail.charAt(1) || null,
  };
}

export function importedEngineerMatchKey(sourceName: string): string {
  const parsed = parseSourceSurnameInitials(sourceName);
  if (parsed) {
    return `${parsed.surname}|${parsed.firstInitial}|${parsed.patronymicInitial ?? ''}`;
  }
  return foldEngineerKey(sourceName);
}

export function accountMatchesSource(accountFullName: string, sourceName: string): boolean {
  if (foldEngineerKey(accountFullName) === foldEngineerKey(sourceName)) {
    return true;
  }
  const source = parseSourceSurnameInitials(sourceName);
  const account = parseAccountPerson(accountFullName);
  if (!source || !account) {
    return false;
  }
  if (source.surname !== account.surname) {
    return false;
  }
  if (source.firstInitial !== account.firstInitial) {
    return false;
  }
  if (source.patronymicInitial) {
    if (!account.patronymicInitial) {
      return false;
    }
    if (source.patronymicInitial !== account.patronymicInitial) {
      return false;
    }
  }
  return true;
}

export function classifyEngineerMatch<T extends EngineerMatchCandidate>(
  sourceName: string | null | undefined,
  candidates: readonly T[],
): EngineerMatchClassification<T> {
  if (!sourceName || foldEngineerKey(sourceName).length === 0) {
    return { result: 'EMPTY', matches: [] };
  }
  const eligible = candidates.filter(
    (item) => item.role === 'RESPONSIBLE_ENGINEER' && item.status === 'ACTIVE',
  );
  const matches = eligible.filter((item) => accountMatchesSource(item.fullName, sourceName));
  if (matches.length === 1) {
    return { result: 'MATCHED', matches };
  }
  if (matches.length > 1) {
    return { result: 'AMBIGUOUS', matches };
  }
  if (!isPlausibleSourceName(sourceName)) {
    return { result: 'INVALID', matches: [] };
  }
  return { result: 'UNMATCHED', matches: [] };
}

export function isPlausibleSourceName(sourceName: string): boolean {
  return parseSourceSurnameInitials(sourceName) !== null || parseAccountPerson(sourceName) !== null;
}

function parseAccountPerson(value: string): {
  surname: string;
  surnameDisplay: string;
  givenName: string | null;
  patronymic: string | null;
  firstInitial: string;
  patronymicInitial: string | null;
} | null {
  const display = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!display) {
    return null;
  }
  const displayTokens = display.split(' ');
  const folded = foldEngineerKey(display);
  const tokens = folded.split(' ');
  if (tokens.length >= 2 && tokens.length <= 3 && tokens.every((token) => NAME_WORD.test(token))) {
    return {
      surname: tokens[0]!,
      surnameDisplay: displayTokens[0]!,
      givenName: displayTokens[1] ?? null,
      patronymic: displayTokens[2] ?? null,
      firstInitial: tokens[1]!.charAt(0),
      patronymicInitial: tokens[2]?.charAt(0) ?? null,
    };
  }
  const asInitials = parseSourceSurnameInitials(value);
  if (!asInitials) {
    return null;
  }
  return {
    surname: asInitials.surname,
    surnameDisplay: displayTokens[0]!,
    givenName: null,
    patronymic: null,
    firstInitial: asInitials.firstInitial,
    patronymicInitial: asInitials.patronymicInitial,
  };
}
