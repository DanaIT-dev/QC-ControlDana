import type { SlaClockKind, SlaClockState } from '@sgr-registry/contracts';
import {
  BUSINESS_TIME_ZONE,
  addCalendarDays,
  calendarDateInTimeZone,
  effectiveDeadlineOf,
} from './deadline';

export type { SlaClockKind, SlaClockState };
export const DEFAULT_ESCALATION_DAYS = [0, 3, 7, 14] as const;
export const DEFAULT_DAILY_EVALUATION_MINUTE = 8 * 60;

export function calendarDiffDays(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T12:00:00.000Z`);
  const to = Date.parse(`${toIso}T12:00:00.000Z`);
  return Math.round((to - from) / 86_400_000);
}

export function slaStateOf(input: {
  status: 'IN_PROGRESS' | 'COMPLETED';
  deadline: Date | null;
  warningDays: number;
  now?: Date;
  timeZone?: string;
}): SlaClockState {
  if (input.status === 'COMPLETED') {
    return 'COMPLETED';
  }
  if (!input.deadline) {
    return 'NO_DEADLINE';
  }
  const timeZone = input.timeZone ?? BUSINESS_TIME_ZONE;
  const today = calendarDateInTimeZone(input.now ?? new Date(), timeZone);
  const deadlineDate = calendarDateInTimeZone(input.deadline, timeZone);
  if (deadlineDate < today) {
    return 'OVERDUE';
  }
  if (deadlineDate === today) {
    return 'DUE_TODAY';
  }
  const warningLastDay = addCalendarDays(today, input.warningDays);
  if (deadlineDate <= warningLastDay) {
    return 'WARNING';
  }
  return 'NORMAL';
}

export function overdueDaysOf(input: {
  deadline: Date | null;
  now?: Date;
  timeZone?: string;
}): number | null {
  if (!input.deadline) {
    return null;
  }
  const timeZone = input.timeZone ?? BUSINESS_TIME_ZONE;
  const today = calendarDateInTimeZone(input.now ?? new Date(), timeZone);
  const deadlineDate = calendarDateInTimeZone(input.deadline, timeZone);
  const days = calendarDiffDays(deadlineDate, today);
  return days >= 0 ? days : null;
}

export function daysUntilDeadline(input: {
  deadline: Date | null;
  now?: Date;
  timeZone?: string;
}): number | null {
  if (!input.deadline) {
    return null;
  }
  const timeZone = input.timeZone ?? BUSINESS_TIME_ZONE;
  const today = calendarDateInTimeZone(input.now ?? new Date(), timeZone);
  const deadlineDate = calendarDateInTimeZone(input.deadline, timeZone);
  return calendarDiffDays(today, deadlineDate);
}

export function reachedEscalationThresholds(
  overdueDays: number | null,
  thresholds: readonly number[] = DEFAULT_ESCALATION_DAYS,
): number[] {
  if (overdueDays === null) {
    return [];
  }
  return [...thresholds].filter((threshold) => threshold <= overdueDays).sort((a, b) => a - b);
}

export function generalDeadlineFingerprint(input: {
  claimDeadline: Date | null;
  plannedDeadline: Date | null;
}): string | null {
  const effective = effectiveDeadlineOf(input);
  return effective ? calendarDateInTimeZone(effective) : null;
}

export function shouldBumpGeneralCycle(input: {
  previousClaim: Date | null;
  previousPlanned: Date | null;
  nextClaim: Date | null;
  nextPlanned: Date | null;
}): boolean {
  return (
    generalDeadlineFingerprint({
      claimDeadline: input.previousClaim,
      plannedDeadline: input.previousPlanned,
    }) !==
    generalDeadlineFingerprint({
      claimDeadline: input.nextClaim,
      plannedDeadline: input.nextPlanned,
    })
  );
}

export function nextClockCycle(input: { previousCycle: number | null; bump: boolean }): number {
  if (input.previousCycle === null) {
    return 1;
  }
  return input.bump ? input.previousCycle + 1 : input.previousCycle;
}

export function nextDailyEvaluationAt(
  minuteOfDay: number,
  now = new Date(),
  timeZone: string = BUSINESS_TIME_ZONE,
): Date {
  const today = calendarDateInTimeZone(now, timeZone);
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  const [hourPart, minutePart] = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(now)
    .split(':');
  const currentMinute = Number(hourPart) * 60 + Number(minutePart);
  const targetDate = addCalendarDays(today, currentMinute >= minuteOfDay ? 1 : 0);
  return new Date(
    `${targetDate}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00+03:00`,
  );
}

export function displaySlaLabel(state: SlaClockState): string {
  switch (state) {
    case 'NO_DEADLINE':
      return 'Без срока';
    case 'NORMAL':
      return 'В норме';
    case 'WARNING':
      return 'Приближается срок';
    case 'DUE_TODAY':
      return 'Срок сегодня / Просрочено';
    case 'OVERDUE':
      return 'Просрочено';
    case 'COMPLETED':
      return 'Завершено';
    default:
      return state;
  }
}

export function slaBucketOf(input: {
  state: SlaClockState;
  overdueDays: number | null;
}):
  | 'WARNING'
  | 'DUE_TODAY'
  | 'OVERDUE_1_2'
  | 'OVERDUE_3_6'
  | 'OVERDUE_7_PLUS'
  | 'NO_DEADLINE'
  | 'OTHER' {
  if (input.state === 'NO_DEADLINE') {
    return 'NO_DEADLINE';
  }
  if (input.state === 'WARNING') {
    return 'WARNING';
  }
  if (input.state === 'DUE_TODAY') {
    return 'DUE_TODAY';
  }
  if (input.state === 'OVERDUE' && input.overdueDays !== null) {
    if (input.overdueDays >= 7) {
      return 'OVERDUE_7_PLUS';
    }
    if (input.overdueDays >= 3) {
      return 'OVERDUE_3_6';
    }
    return 'OVERDUE_1_2';
  }
  return 'OTHER';
}
