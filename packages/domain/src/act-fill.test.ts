import { describe, expect, it } from 'vitest';
import { actStatusLabel } from './registry-labels';
import { calendarDateToUtcNoon } from './deadline';
import {
  ACT_FILL_LABELS,
  DEADLINE_ALREADY_PASSED_NOTICE,
  DEADLINE_CONTROL_NOT_STARTED,
  MISSING_DEADLINE_LABEL,
  actFillState,
  deadlinePresentation,
  remainingDaysLabel,
  userFacingLabelsOmitSla,
} from './act-fill';

const NOW = new Date('2026-10-21T09:00:00.000Z');

describe('act status label', () => {
  it('shows NEW as an unset status and keeps the stored value explicit', () => {
    expect(actStatusLabel('NEW')).toBe('Статус не установлен');
    expect(actStatusLabel('NEW')).not.toBeNull();
    expect(['Черновик', 'Создан', 'Новый', 'Новый акт']).not.toContain(actStatusLabel('NEW'));
  });
});

describe('deadline before and after start', () => {
  it('keeps a deadline on a NEW act and reports remaining days without active overdue', () => {
    const deadline = calendarDateToUtcNoon('2026-10-26');
    const before = deadlinePresentation({
      actStatus: 'NEW',
      startedAt: null,
      defectStatus: 'IN_PROGRESS',
      claimDeadline: null,
      plannedDeadline: deadline,
      deadlineWarningDays: 3,
      now: NOW,
    });
    expect(before.daysRemaining).toBe(5);
    expect(before.daysRemainingLabel).toBe('Осталось 5 дней');
    expect(remainingDaysLabel(1)).toBe('Остался 1 день');
    expect(remainingDaysLabel(0)).toBe('Срок наступает сегодня');
    expect(before.deadlineNotice).toBe(DEADLINE_CONTROL_NOT_STARTED);
    expect(before.deadlineControlActive).toBe(false);
    expect(before.deadlineState).not.toBe('OVERDUE');
    expect(before.deadlineStateLabel).not.toMatch(/SLA/i);
  });

  it('warns when the date has passed before work starts', () => {
    const shown = deadlinePresentation({
      actStatus: 'NEW',
      startedAt: null,
      defectStatus: 'IN_PROGRESS',
      claimDeadline: null,
      plannedDeadline: calendarDateToUtcNoon('2026-10-01'),
      deadlineWarningDays: 3,
      now: NOW,
    });
    expect(shown.deadlineNotice).toBe(DEADLINE_ALREADY_PASSED_NOTICE);
    expect(shown.deadlineControlActive).toBe(false);
    expect(shown.deadlineState).not.toBe('OVERDUE');
  });

  it('does not change or invent a deadline when work starts', () => {
    const deadline = calendarDateToUtcNoon('2026-10-30');
    const startedAt = new Date('2026-10-21T10:00:00.000Z');
    const after = deadlinePresentation({
      actStatus: 'IN_PROGRESS',
      startedAt,
      defectStatus: 'IN_PROGRESS',
      claimDeadline: null,
      plannedDeadline: deadline,
      deadlineWarningDays: 3,
      now: NOW,
    });
    expect(after.deadlineControlActive).toBe(true);
    expect(effectiveIso(deadline)).toBe('2026-10-30');
    expect(after.daysRemaining).toBe(9);

    const withoutDate = deadlinePresentation({
      actStatus: 'IN_PROGRESS',
      startedAt,
      defectStatus: 'IN_PROGRESS',
      claimDeadline: null,
      plannedDeadline: null,
      deadlineWarningDays: 3,
      now: NOW,
    });
    expect(withoutDate.deadlineState).toBe('NO_DEADLINE');
    expect(withoutDate.deadlineStateLabel).toBe(MISSING_DEADLINE_LABEL);
    expect(withoutDate.daysRemaining).toBeNull();
    expect(withoutDate.deadlineControlActive).toBe(false);
  });

  it('marks a past deadline as active overdue only after start', () => {
    const deadline = calendarDateToUtcNoon('2026-10-01');
    const after = deadlinePresentation({
      actStatus: 'IN_PROGRESS',
      startedAt: new Date('2026-10-21T10:00:00.000Z'),
      defectStatus: 'IN_PROGRESS',
      claimDeadline: null,
      plannedDeadline: deadline,
      deadlineWarningDays: 3,
      now: NOW,
    });
    expect(after.deadlineControlActive).toBe(true);
    expect(after.deadlineState).toBe('OVERDUE');
    expect(effectiveIso(deadline)).toBe('2026-10-01');
  });

  it('starts control when a deadline is added after work has started', () => {
    const added = deadlinePresentation({
      actStatus: 'IN_PROGRESS',
      startedAt: new Date('2026-10-20T10:00:00.000Z'),
      defectStatus: 'IN_PROGRESS',
      claimDeadline: null,
      plannedDeadline: calendarDateToUtcNoon('2026-10-21'),
      deadlineWarningDays: 3,
      now: NOW,
    });
    expect(added.deadlineControlActive).toBe(true);
    expect(added.daysRemainingLabel).toBe('Срок наступает сегодня');
  });
});

describe('fill state', () => {
  it('separates an empty act from an incomplete one and a ready one', () => {
    expect(
      actFillState({
        officialNumber: null,
        formCode: null,
        objectId: null,
        customerOrganizationId: null,
        issuedOn: null,
        defects: [],
      }),
    ).toBe('EMPTY');
    expect(ACT_FILL_LABELS.EMPTY).toBe('Не заполнен');
    expect(
      actFillState({
        officialNumber: null,
        formCode: 'S1',
        objectId: null,
        customerOrganizationId: null,
        issuedOn: null,
        defects: [{ location: 'Кухня', defectTypeId: null }],
      }),
    ).toBe('INCOMPLETE');
    expect(ACT_FILL_LABELS.INCOMPLETE).toBe('Требует заполнения');
    expect(
      actFillState({
        officialNumber: 'С-1-2026-000001',
        formCode: 'S1',
        objectId: 'object',
        customerOrganizationId: 'customer',
        issuedOn: '2026-10-16',
        defects: [{ defectTypeId: 'type' }],
      }),
    ).toBe('READY');
    expect(ACT_FILL_LABELS.READY).toBe('Готов к работе');
  });
});

describe('user-facing copy', () => {
  it('does not use the SLA abbreviation', () => {
    expect(userFacingLabelsOmitSla()).toBe(true);
    expect(actStatusLabel('NEW')).not.toMatch(/SLA/i);
    expect(DEADLINE_CONTROL_NOT_STARTED).not.toMatch(/SLA/i);
  });
});

function effectiveIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
