import { describe, expect, it } from 'vitest';
import {
  formatDisplayDate,
  isRealCalendarDate,
  maskDateInput,
  monthGrid,
  parseDisplayDate,
} from '../lib/calendar-date';
import { objectTableColumns } from '../lib/objects-table-layout';

describe('calendar date input', () => {
  it('formats and parses a calendar day without using the local timezone', () => {
    expect(formatDisplayDate('2024-01-15')).toBe('15.01.2024');
    expect(parseDisplayDate('15.01.2024')).toEqual({ ok: true, value: '2024-01-15' });
    expect(parseDisplayDate('2024-01-15')).toEqual({ ok: true, value: '2024-01-15' });
    expect(parseDisplayDate('')).toEqual({ ok: true, value: '' });
    expect(parseDisplayDate('31.02.2024').ok).toBe(false);
    expect(parseDisplayDate('29.02.2024')).toEqual({ ok: true, value: '2024-02-29' });
    expect(isRealCalendarDate(2023, 2, 29)).toBe(false);
    expect(maskDateInput('15012024')).toBe('15.01.2024');
    expect(maskDateInput('2024-01-15')).toBe('15.01.2024');
  });

  it('builds a Monday-first month without shifting the day', () => {
    const rows = monthGrid(2024, 1);
    expect(rows[0]?.[0]).toBe('2024-01-01');
    expect(rows.flat().filter(Boolean)).toHaveLength(31);
  });
});

describe('object table columns', () => {
  it('gives the free width to the name and address and keeps dates compact', () => {
    const wide = objectTableColumns(1200, true);
    expect(wide.scrolls).toBe(false);
    expect(wide.commissioned).toBe(124);
    expect(wide.warranty).toBe(124);
    expect(wide.name + wide.address).toBeGreaterThan(wide.engineers + wide.commissioned);
    expect(wide.tableWidth).toBe(1200);

    const tablet = objectTableColumns(720, true);
    expect(tablet.scrolls).toBe(true);
    expect(tablet.commissioned).toBe(124);
    expect(tablet.name).toBeGreaterThanOrEqual(168);
    expect(tablet.address).toBeGreaterThanOrEqual(200);
    expect(tablet.actions).toBeGreaterThan(0);
  });
});
