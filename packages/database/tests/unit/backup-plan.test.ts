import { describe, expect, it } from 'vitest';
import { backupClassFor, selectBackupsToDelete } from '../../src/backup-plan';

describe('backup retention', () => {
  it('classifies the first day of a month as monthly and Sundays as weekly', () => {
    expect(backupClassFor(new Date('2026-09-01T00:00:00.000Z'))).toBe('monthly');
    expect(backupClassFor(new Date('2026-09-06T00:00:00.000Z'))).toBe('weekly');
    expect(backupClassFor(new Date('2026-09-02T00:00:00.000Z'))).toBe('daily');
  });

  it('keeps 7 daily, 4 weekly and 3 monthly copies', () => {
    const records = [
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `daily-${index}`,
        createdAt: `2026-08-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`,
        backupClass: 'daily' as const,
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `weekly-${index}`,
        createdAt: `2026-07-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`,
        backupClass: 'weekly' as const,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `monthly-${index}`,
        createdAt: `2026-0${index + 1}-01T00:00:00.000Z`,
        backupClass: 'monthly' as const,
      })),
    ];
    const drop = selectBackupsToDelete(records);
    expect(drop.filter((id) => id.startsWith('daily-'))).toHaveLength(2);
    expect(drop.filter((id) => id.startsWith('weekly-'))).toHaveLength(1);
    expect(drop.filter((id) => id.startsWith('monthly-'))).toHaveLength(1);
    expect(drop).toContain('daily-0');
    expect(drop).not.toContain('daily-8');
    expect(drop).toContain('monthly-0');
    expect(drop).not.toContain('monthly-3');
  });
});
