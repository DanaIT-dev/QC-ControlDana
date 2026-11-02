import { describe, expect, it } from 'vitest';
import { calendarDateInTimeZone, calendarDateToUtcNoon } from './deadline';
import { ValidationError } from './errors';
import { resolvePropertyObjectDateUpdate } from './property-object-dates';

describe('resolvePropertyObjectDateUpdate', () => {
  it('sets both dates, changes one, and clears one without touching the other', () => {
    expect(
      resolvePropertyObjectDateUpdate({
        currentCommissionedAt: null,
        currentWarrantyEndsAt: null,
        commissionedAt: '2024-05-01',
        warrantyEndsAt: '2029-05-01',
      }),
    ).toEqual({
      commissionedAt: '2024-05-01',
      setCommissionedAt: true,
      warrantyEndsAt: '2029-05-01',
      setWarrantyEndsAt: true,
    });

    expect(
      resolvePropertyObjectDateUpdate({
        currentCommissionedAt: '2024-05-01',
        currentWarrantyEndsAt: '2029-05-01',
        commissionedAt: '2024-06-01',
      }),
    ).toMatchObject({
      commissionedAt: '2024-06-01',
      setCommissionedAt: true,
      warrantyEndsAt: '2029-05-01',
      setWarrantyEndsAt: false,
    });

    expect(
      resolvePropertyObjectDateUpdate({
        currentCommissionedAt: '2024-05-01',
        currentWarrantyEndsAt: '2029-05-01',
        warrantyEndsAt: null,
      }),
    ).toMatchObject({
      commissionedAt: '2024-05-01',
      setCommissionedAt: false,
      warrantyEndsAt: null,
      setWarrantyEndsAt: true,
    });
  });

  it('leaves dates unchanged when the fields are omitted or repeat the current calendar day', () => {
    expect(
      resolvePropertyObjectDateUpdate({
        currentCommissionedAt: '2024-05-01',
        currentWarrantyEndsAt: '2029-05-01',
      }),
    ).toEqual({
      commissionedAt: '2024-05-01',
      setCommissionedAt: false,
      warrantyEndsAt: '2029-05-01',
      setWarrantyEndsAt: false,
    });

    expect(
      resolvePropertyObjectDateUpdate({
        currentCommissionedAt: '2024-05-01',
        currentWarrantyEndsAt: null,
        commissionedAt: '2024-05-01',
        warrantyEndsAt: null,
      }),
    ).toMatchObject({ setCommissionedAt: false, setWarrantyEndsAt: false });
  });

  it('rejects an invalid date and a warranty that moves before acceptance', () => {
    expect(() =>
      resolvePropertyObjectDateUpdate({
        currentCommissionedAt: null,
        currentWarrantyEndsAt: null,
        commissionedAt: '2024-02-31',
      }),
    ).toThrow(ValidationError);

    expect(() =>
      resolvePropertyObjectDateUpdate({
        currentCommissionedAt: '2024-06-02',
        currentWarrantyEndsAt: '2029-06-01',
        warrantyEndsAt: '2024-06-01',
      }),
    ).toThrow(/раньше даты приёмки/);

    expect(() =>
      resolvePropertyObjectDateUpdate({
        currentCommissionedAt: '2024-01-01',
        currentWarrantyEndsAt: '2029-01-01',
        commissionedAt: '2030-01-01',
      }),
    ).toThrow(/раньше даты приёмки/);
  });

  it('does not block an unchanged historical mismatch', () => {
    expect(
      resolvePropertyObjectDateUpdate({
        currentCommissionedAt: '2024-06-02',
        currentWarrantyEndsAt: '2024-06-01',
        commissionedAt: '2024-06-02',
        warrantyEndsAt: '2024-06-01',
      }),
    ).toMatchObject({ setCommissionedAt: false, setWarrantyEndsAt: false });

    expect(
      resolvePropertyObjectDateUpdate({
        currentCommissionedAt: '2024-06-02',
        currentWarrantyEndsAt: '2024-06-01',
      }),
    ).toMatchObject({ setCommissionedAt: false, setWarrantyEndsAt: false });
  });

  it('keeps a stored UTC-noon calendar day in the business zone and ordinary offsets', () => {
    const stored = calendarDateToUtcNoon('2024-01-15');
    for (const zone of ['UTC', 'Europe/Minsk', 'America/Los_Angeles', 'Asia/Tokyo']) {
      expect(calendarDateInTimeZone(stored, zone)).toBe('2024-01-15');
    }
  });
});
