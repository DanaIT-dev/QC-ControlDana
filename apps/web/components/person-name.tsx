'use client';

import {
  formatPersonFull,
  formatPersonShort,
  parsePersonNameForForm,
  parseSourceSurnameInitials,
  parseStoredOfficialPersonName,
  type PersonNameParts,
} from '@sgr-registry/domain';
import { cn } from '@/lib/utils';

function shortNameParts(
  parts: PersonNameParts,
  fullName: string,
): { lastName: string; initials: string } {
  const display = fullName.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (parseSourceSurnameInitials(display)) {
    const separator = display.indexOf(' ');
    return {
      lastName: display.slice(0, separator),
      initials: display.slice(separator + 1).trim(),
    };
  }
  const lastName = parts.lastName.trim();
  const short = formatPersonShort(parts);
  if (!short) {
    return { lastName: '—', initials: '' };
  }
  if (lastName && short.startsWith(lastName)) {
    return { lastName, initials: short.slice(lastName.length).trim() };
  }
  return { lastName: short, initials: '' };
}

export function PersonName({
  lastName,
  firstName,
  middleName,
  fullName,
  unmatched = false,
  sourceNameRaw,
  className,
}: {
  lastName?: string | null;
  firstName?: string | null;
  middleName?: string | null;
  fullName?: string | null;
  unmatched?: boolean;
  sourceNameRaw?: string | null;
  className?: string;
}) {
  if (unmatched || (!fullName && !lastName && sourceNameRaw)) {
    const raw = sourceNameRaw || fullName || '—';
    return (
      <span
        data-slot="person-name"
        className={cn(
          'inline-flex min-w-0 max-w-full flex-col items-start gap-0.5 align-top leading-5',
          className,
        )}
        title={raw}
      >
        <span className="max-w-full truncate whitespace-nowrap text-sm font-medium leading-5">
          {raw}
        </span>
        <span className="text-[13px] leading-5 text-muted-foreground">Инженер не сопоставлен</span>
      </span>
    );
  }
  const parts: PersonNameParts =
    lastName && firstName
      ? { lastName, firstName, middleName: middleName ?? null }
      : (() => {
          const official = parseStoredOfficialPersonName(fullName ?? '');
          return official.ok ? official.parts : parsePersonNameForForm(fullName ?? '');
        })();
  const official = formatPersonFull(parts) || fullName || '';
  const { lastName: surname, initials } = shortNameParts(parts, official);
  return (
    <span
      data-slot="person-name"
      className={cn(
        'inline-flex min-w-0 max-w-full items-baseline align-baseline leading-[inherit]',
        className,
      )}
      title={official}
      aria-label={official}
    >
      <span className="min-w-0 truncate whitespace-nowrap">{surname}</span>
      {initials ? (
        <span className="shrink-0 whitespace-nowrap">{`\u00A0${initials}`}</span>
      ) : null}
    </span>
  );
}
