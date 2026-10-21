import type { ActStatus, DeadlineState, DefectItemStatus } from '@sgr-registry/contracts';
import { draftStartGaps, isBlankDraftDefect } from './draft-act';
import { deadlineStateOf, effectiveDeadlineOf } from './deadline';
import { deadlineStateLabel } from './registry-labels';
import { daysUntilDeadline, overdueDaysOf } from './sla';

export const ACT_FILL_STATES = ['EMPTY', 'INCOMPLETE', 'READY'] as const;
export type ActFillState = (typeof ACT_FILL_STATES)[number];

export const ACT_FILL_LABELS: Record<ActFillState, string> = {
  EMPTY: 'Не заполнен',
  INCOMPLETE: 'Требует заполнения',
  READY: 'Готов к работе',
};

export const ASSIGNMENT_REQUIRED_LABEL = 'Требует назначения';
export const MISSING_OBJECT_LABEL = 'Объект не указан';
export const MISSING_ENGINEER_LABEL = 'Ответственный не назначен';
export const MISSING_DEADLINE_LABEL = 'Срок не установлен';
export const DEADLINE_CONTROL_NOT_STARTED = 'Контроль сроков ещё не запущен';
export const DEADLINE_ALREADY_PASSED_NOTICE =
  'Указанный срок уже прошёл. Контроль сроков ещё не запущен.';

const USER_FACING_LABELS = [
  ...Object.values(ACT_FILL_LABELS),
  ASSIGNMENT_REQUIRED_LABEL,
  MISSING_OBJECT_LABEL,
  MISSING_ENGINEER_LABEL,
  MISSING_DEADLINE_LABEL,
  DEADLINE_CONTROL_NOT_STARTED,
  DEADLINE_ALREADY_PASSED_NOTICE,
];

export function userFacingLabelsOmitSla(labels: readonly string[] = USER_FACING_LABELS): boolean {
  return labels.every((label) => !/\bSLA\b/i.test(label));
}

export function actFillLabel(state: ActFillState): string {
  return ACT_FILL_LABELS[state];
}

export function displayObjectName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : MISSING_OBJECT_LABEL;
}

export function displayEngineerNames(names: readonly string[]): string {
  const present = names.map((name) => name.trim()).filter((name) => name.length > 0);
  return present.length > 0 ? present.join(', ') : MISSING_ENGINEER_LABEL;
}

export function assignmentLabel(responsibleCount: number): string | null {
  return responsibleCount > 0 ? null : ASSIGNMENT_REQUIRED_LABEL;
}

export interface ActFillDefectInput {
  location?: string | null;
  defectTypeId?: string | null;
  workTypeId?: string | null;
  claimDetails?: string | null;
  notes?: string | null;
  responsibleCount?: number;
  liableCount?: number;
  plannedDeadline?: string | null;
  claimDeadline?: string | null;
  thirdPartyDeadline?: string | null;
}

export function actFillState(input: {
  officialNumber?: string | null;
  formCode?: string | null;
  objectId?: string | null;
  customerOrganizationId?: string | null;
  issuedOn?: Date | string | null;
  defects: readonly ActFillDefectInput[];
}): ActFillState {
  const headerEmpty =
    !present(input.officialNumber) &&
    !present(input.formCode) &&
    !present(input.objectId) &&
    !present(input.customerOrganizationId) &&
    !input.issuedOn;
  const defectsEmpty =
    input.defects.length === 0 ||
    input.defects.every((item) =>
      isBlankDraftDefect({
        location: item.location,
        defectTypeId: item.defectTypeId,
        workTypeId: item.workTypeId,
        claimDetails: item.claimDetails,
        notes: item.notes,
        responsibleEngineerIds:
          (item.responsibleCount ?? 0) > 0
            ? Array.from({ length: item.responsibleCount ?? 0 })
            : [],
        liableOrganizationIds:
          (item.liableCount ?? 0) > 0 ? Array.from({ length: item.liableCount ?? 0 }) : [],
        plannedDeadline: item.plannedDeadline,
        claimDeadline: item.claimDeadline,
        thirdPartyDeadline: item.thirdPartyDeadline,
      }),
    );
  if (headerEmpty && defectsEmpty) {
    return 'EMPTY';
  }
  const gaps = draftStartGaps({
    objectId: input.objectId ?? null,
    customerOrganizationId: input.customerOrganizationId ?? null,
    issuedOn: input.issuedOn ?? null,
    formCode: input.formCode ?? null,
    defects: input.defects.map((item) => ({ defectTypeId: item.defectTypeId ?? null })),
  });
  return gaps.length === 0 ? 'READY' : 'INCOMPLETE';
}

export function remainingDaysLabel(days: number): string {
  if (days === 0) {
    return 'Срок наступает сегодня';
  }
  if (days === 1) {
    return 'Остался 1 день';
  }
  return `Осталось ${days} ${dayNoun(days)}`;
}

export interface DeadlinePresentation {
  deadlineState: DeadlineState;
  deadlineStateLabel: string;
  daysRemaining: number | null;
  daysRemainingLabel: string | null;
  deadlineNotice: string | null;
  deadlineControlActive: boolean;
}

export function deadlinePresentation(input: {
  actStatus: ActStatus;
  startedAt: Date | null;
  defectStatus: DefectItemStatus;
  claimDeadline: Date | null;
  plannedDeadline: Date | null;
  deadlineWarningDays: number;
  now?: Date;
  timeZone?: string;
}): DeadlinePresentation {
  const effective = effectiveDeadlineOf({
    claimDeadline: input.claimDeadline,
    plannedDeadline: input.plannedDeadline,
  });
  const controlStarted =
    input.startedAt != null &&
    (input.actStatus === 'IN_PROGRESS' || input.actStatus === 'COMPLETED');
  const days = effective
    ? daysUntilDeadline({
        deadline: effective,
        now: input.now,
        timeZone: input.timeZone,
      })
    : null;

  if (!controlStarted) {
    if (!effective || days === null) {
      return {
        deadlineState: 'NO_DEADLINE',
        deadlineStateLabel: MISSING_DEADLINE_LABEL,
        daysRemaining: null,
        daysRemainingLabel: null,
        deadlineNotice: null,
        deadlineControlActive: false,
      };
    }
    if (days < 0) {
      return {
        deadlineState: 'NORMAL',
        deadlineStateLabel: DEADLINE_ALREADY_PASSED_NOTICE,
        daysRemaining: days,
        daysRemainingLabel: null,
        deadlineNotice: DEADLINE_ALREADY_PASSED_NOTICE,
        deadlineControlActive: false,
      };
    }
    const label = remainingDaysLabel(days);
    return {
      deadlineState: 'NORMAL',
      deadlineStateLabel: label,
      daysRemaining: days,
      daysRemainingLabel: label,
      deadlineNotice: DEADLINE_CONTROL_NOT_STARTED,
      deadlineControlActive: false,
    };
  }

  if (!effective) {
    return {
      deadlineState: 'NO_DEADLINE',
      deadlineStateLabel: MISSING_DEADLINE_LABEL,
      daysRemaining: null,
      daysRemainingLabel: null,
      deadlineNotice: null,
      deadlineControlActive: false,
    };
  }

  const deadlineState = deadlineStateOf({
    status: input.defectStatus,
    claimDeadline: input.claimDeadline,
    plannedDeadline: input.plannedDeadline,
    deadlineWarningDays: input.deadlineWarningDays,
    now: input.now,
    timeZone: input.timeZone,
  });
  return {
    deadlineState,
    deadlineStateLabel: deadlineStateLabel(deadlineState),
    daysRemaining: days,
    daysRemainingLabel: days !== null && days >= 0 ? remainingDaysLabel(days) : null,
    deadlineNotice: null,
    deadlineControlActive: true,
  };
}

export function activationOverdueDays(input: {
  claimDeadline: Date | null;
  plannedDeadline: Date | null;
  now?: Date;
  timeZone?: string;
}): number | null {
  const deadline = effectiveDeadlineOf(input);
  if (!deadline) {
    return null;
  }
  return overdueDaysOf({ deadline, now: input.now, timeZone: input.timeZone });
}

function dayNoun(days: number): string {
  const mod10 = days % 10;
  const mod100 = days % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return 'день';
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return 'дня';
  }
  return 'дней';
}

function present(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
