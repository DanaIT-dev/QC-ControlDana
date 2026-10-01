import { DEADLINE_STATES, type DeadlineState } from '@sgr-registry/contracts';

export const BUSINESS_TIME_ZONE = 'Europe/Minsk';

export type { DeadlineState };
export { DEADLINE_STATES };

export function calendarDateInTimeZone(date: Date, timeZone: string = BUSINESS_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new Error('Failed to format a calendar date');
  }
  return `${year}-${month}-${day}`;
}

export function addCalendarDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map((value) => Number.parseInt(value, 10));
  if (!year || !month || !day) {
    throw new Error('Invalid calendar date');
  }
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`;
}

export function calendarDateToUtcNoon(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00.000Z`);
}

export function zonedOffsetMs(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day),
    Number(value.hour),
    Number(value.minute),
    Number(value.second),
  );
  return asUtc - date.getTime();
}

export function startOfZonedDayUtc(isoDate: string, timeZone: string = BUSINESS_TIME_ZONE): Date {
  const [year, month, day] = isoDate.split('-').map((value) => Number.parseInt(value, 10));
  if (!year || !month || !day) {
    throw new Error('Invalid calendar date');
  }
  const utcMidnight = Date.UTC(year, month - 1, day);
  const offsetMs = zonedOffsetMs(timeZone, new Date(utcMidnight));
  return new Date(utcMidnight - offsetMs);
}

export function effectiveDeadlineOf(input: {
  claimDeadline: Date | null;
  plannedDeadline: Date | null;
}): Date | null {
  return input.claimDeadline ?? input.plannedDeadline;
}

export function deadlineStateOf(input: {
  status: 'IN_PROGRESS' | 'PENDING_INSPECTION' | 'COMPLETED';
  claimDeadline: Date | null;
  plannedDeadline: Date | null;
  deadlineWarningDays: number;
  now?: Date;
  timeZone?: string;
}): DeadlineState {
  if (input.status === 'COMPLETED') {
    return 'COMPLETED';
  }
  const effective = effectiveDeadlineOf(input);
  if (!effective) {
    return 'NO_DEADLINE';
  }
  const timeZone = input.timeZone ?? BUSINESS_TIME_ZONE;
  const today = calendarDateInTimeZone(input.now ?? new Date(), timeZone);
  const deadlineDate = calendarDateInTimeZone(effective, timeZone);
  if (deadlineDate <= today) {
    return 'OVERDUE';
  }
  const warningLastDay = addCalendarDays(today, input.deadlineWarningDays);
  if (deadlineDate <= warningLastDay) {
    return 'WARNING';
  }
  return 'NORMAL';
}

export function serializeDecimal(
  value: { toFixed(digits: number): string } | string | number,
): string {
  if (typeof value === 'string') {
    if (!/^-?\d+(\.\d+)?$/.test(value)) {
      throw new Error('Invalid decimal value');
    }
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  }
  if (typeof value === 'number') {
    throw new Error('Refusing to serialize a binary floating-point amount');
  }
  return value.toFixed(2);
}
