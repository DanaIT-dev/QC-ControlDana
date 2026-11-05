import { describe, expect, it } from 'vitest';
import type { RegistrySortField, SortDirection } from './registry-query';
import { compareRegistrySortRows, type RegistrySortRow } from './registry-sort';

function row(
  patch: Partial<RegistrySortRow> & Pick<RegistrySortRow, 'id' | 'actId'>,
): RegistrySortRow {
  return {
    defectId: patch.id,
    issuedOn: null,
    actCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    officialNumber: null,
    status: 'IN_PROGRESS',
    objectName: null,
    defectTypeName: null,
    plannedDeadline: null,
    claimDeadline: null,
    effectiveDeadline: null,
    readyAt: null,
    rowCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...patch,
  };
}

function ordered(
  rows: RegistrySortRow[],
  sortBy: RegistrySortField = 'issuedOn',
  direction: SortDirection = 'desc',
) {
  return [...rows]
    .sort((left, right) => compareRegistrySortRows(left, right, sortBy, direction))
    .map((item) => item.id);
}

describe('registry issuedOn order', () => {
  it('places a later act date ahead of an earlier one and keeps an undated act last', () => {
    const late = row({
      id: 'late',
      actId: 'act-late',
      issuedOn: new Date('2026-11-01T12:00:00.000Z'),
      objectName: 'Якорь',
      actCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const early = row({
      id: 'early',
      actId: 'act-early',
      issuedOn: new Date('2020-01-15T12:00:00.000Z'),
      objectName: 'Альфа',
      actCreatedAt: new Date('2026-11-05T00:00:00.000Z'),
    });
    const blank = row({
      id: 'blank',
      actId: 'act-blank',
      issuedOn: null,
      objectName: 'Бета',
      actCreatedAt: new Date('2026-11-05T12:00:00.000Z'),
    });
    expect(ordered([early, blank, late])).toEqual(['late', 'early', 'blank']);
  });

  it('orders equal dates by act creation time and then by act id', () => {
    const older = row({
      id: 'older',
      actId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      issuedOn: new Date('2024-05-05T12:00:00.000Z'),
      actCreatedAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    const newer = row({
      id: 'newer',
      actId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      issuedOn: new Date('2024-05-05T12:00:00.000Z'),
      actCreatedAt: new Date('2026-11-04T00:00:00.000Z'),
    });
    const sameTimeLaterId = row({
      id: 'same-z',
      actId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
      issuedOn: new Date('2024-05-05T12:00:00.000Z'),
      actCreatedAt: new Date('2026-11-04T00:00:00.000Z'),
    });
    expect(ordered([older, sameTimeLaterId, newer])).toEqual(['newer', 'same-z', 'older']);
  });

  it('keeps defects of one act together and pages without gaps', () => {
    const first = row({ id: 'd1', actId: 'act', defectId: 'd1' });
    const second = row({ id: 'd2', actId: 'act', defectId: 'd2' });
    const other = row({
      id: 'other',
      actId: 'other-act',
      issuedOn: new Date('2026-01-01T12:00:00.000Z'),
    });
    const rows = [second, other, first];
    const sorted = [...rows].sort((left, right) =>
      compareRegistrySortRows(left, right, 'issuedOn', 'desc'),
    );
    expect(sorted.map((item) => item.id)).toEqual(['other', 'd1', 'd2']);
    const pageSize = 2;
    const page1 = sorted.slice(0, pageSize).map((item) => item.id);
    const page2 = sorted.slice(pageSize, pageSize * 2).map((item) => item.id);
    expect(new Set([...page1, ...page2]).size).toBe(3);
    expect([...page1, ...page2]).toEqual(['other', 'd1', 'd2']);
  });

  it('lets an explicit object sort override the act date', () => {
    const late = row({
      id: 'late',
      actId: 'act-late',
      issuedOn: new Date('2026-11-01T12:00:00.000Z'),
      objectName: 'Якорь',
    });
    const early = row({
      id: 'early',
      actId: 'act-early',
      issuedOn: new Date('2020-01-01T12:00:00.000Z'),
      objectName: 'Альфа',
    });
    expect(ordered([late, early], 'objectName', 'asc')).toEqual(['early', 'late']);
  });
});
