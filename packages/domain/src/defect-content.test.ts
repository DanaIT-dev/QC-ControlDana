import { describe, expect, it } from 'vitest';
import { actCompletionSummary, defectNextStep } from './act-completion-guidance';
import { applyDefectContentPatch } from './defect-content';

describe('defect content patch', () => {
  const current = {
    location: 'Кухня',
    defectTypeId: 'type-a',
    workTypeId: null,
    claimDetails: 'Течь',
    notes: null,
  };

  it('keeps omitted fields and reports a type change', () => {
    const result = applyDefectContentPatch(current, {
      defectTypeId: 'type-b',
      claimDetails: 'Трещина',
    });
    expect(result.changed).toBe(true);
    expect(result.next).toEqual({
      ...current,
      defectTypeId: 'type-b',
      claimDetails: 'Трещина',
    });
  });

  it('does not mark an identical patch as a change', () => {
    expect(applyDefectContentPatch(current, { claimDetails: 'Течь' }).changed).toBe(false);
  });
});

describe('act completion guidance', () => {
  it('does not treat an empty act or a pending inspection as finished', () => {
    expect(actCompletionSummary({ actStatus: 'IN_PROGRESS', defectStatuses: [] })).toEqual({
      progress: null,
      hint: 'В акте нет дефектов. Завершить акт нельзя, пока не добавлена хотя бы одна позиция.',
    });
    expect(
      actCompletionSummary({
        actStatus: 'IN_PROGRESS',
        defectStatuses: ['COMPLETED', 'PENDING_INSPECTION', 'IN_PROGRESS'],
      }),
    ).toEqual({
      progress: 'Завершено дефектов: 1 из 3.',
      hint: 'Акт будет завершён после завершения всех его дефектов.',
    });
  });

  it('explains the next step without a separate act button', () => {
    const allowed = {
      canSubmit: true,
      canAcceptOrReject: true,
      canComplete: true,
      canStart: true,
    };
    expect(
      defectNextStep({
        actStatus: 'IN_PROGRESS',
        defectStatus: 'IN_PROGRESS',
        hasLiableOrganization: false,
        ...allowed,
      }),
    ).toContain('завершить дефект');
    expect(
      defectNextStep({
        actStatus: 'IN_PROGRESS',
        defectStatus: 'IN_PROGRESS',
        hasLiableOrganization: true,
        ...allowed,
        canSubmit: false,
      }),
    ).toBeNull();
    expect(
      defectNextStep({
        actStatus: 'IN_PROGRESS',
        defectStatus: 'IN_PROGRESS',
        hasLiableOrganization: true,
        ...allowed,
      }),
    ).toContain('передать дефект на проверку');
    expect(
      defectNextStep({
        actStatus: 'IN_PROGRESS',
        defectStatus: 'PENDING_INSPECTION',
        hasLiableOrganization: true,
        ...allowed,
        canAcceptOrReject: false,
      }),
    ).toBeNull();
    expect(
      defectNextStep({
        actStatus: 'IN_PROGRESS',
        defectStatus: 'PENDING_INSPECTION',
        hasLiableOrganization: true,
        ...allowed,
      }),
    ).toContain('принять устранение');
    expect(
      actCompletionSummary({
        actStatus: 'COMPLETED',
        closureMethod: 'WITHOUT_INSPECTION',
        defectStatuses: ['COMPLETED'],
      }).hint,
    ).toBe('Акт закрыт без проверки устранения.');
    expect(
      defectNextStep({
        actStatus: 'COMPLETED',
        defectStatus: 'COMPLETED',
        hasLiableOrganization: false,
        ...allowed,
      }),
    ).toBeNull();
  });
});
