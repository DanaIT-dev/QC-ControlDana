import { describe, expect, it } from 'vitest';
import { calendarDateToUtcNoon } from './deadline';
import { ValidationError } from './errors';
import {
  OBJECTS_SHEET_NAME,
  OBJECTS_SOURCE_SYSTEM,
  assertObjectsHeaders,
  assertObjectsSheetName,
  buildSourceImportKey,
  cachedExcelValue,
  classifyResponsibleEngineerName,
  excelSerialToIsoDate,
  parseImportedExcelDate,
  parseObjectsSheetMatrix,
  planPropertyObjectsImport,
} from './objects-import';

function sheet(rows: unknown[][]): unknown[][] {
  return [
    [
      'Объекты',
      'Адреса',
      'Дата приёмки в эксплуатацию',
      'Дата завершения гарантийного срока',
      'Ответственный инженер',
    ],
    ...rows,
  ];
}

describe('objects import parser', () => {
  it('requires the Объекты sheet and exact headers', () => {
    expect(() => assertObjectsSheetName(['Реестр актов', 'Организации'])).toThrow(ValidationError);
    assertObjectsSheetName(['Реестр актов', OBJECTS_SHEET_NAME]);
    expect(() =>
      assertObjectsHeaders(['Объекты', 'Адреса', 'Дата', 'Гарантия', 'Инженер']),
    ).toThrow(/Ожидался заголовок/);
    assertObjectsHeaders([
      'Объекты',
      'Адреса',
      'Дата приёмки в эксплуатацию',
      'Дата завершения гарантийного срока',
      'Ответственный инженер',
    ]);
  });

  it('reads only parsed matrix rows and skips blank lines', () => {
    const parsed = parseObjectsSheetMatrix(
      sheet([
        ['2.1 «Волна»', 'пр-т Мира, 1', new Date(Date.UTC(2020, 5, 1)), null, 'Василевич М.В.'],
        [null, null, null, null, null],
        ['2.1 «Волна» (1-й ПК)', 'пр-т Мира, 1', null, null, null],
      ]),
    );
    expect(parsed.sheetName).toBe(OBJECTS_SHEET_NAME);
    expect(parsed.sourceRows).toBe(2);
    expect(parsed.blankRows).toEqual([3]);
    expect(parsed.uniqueRows).toHaveLength(2);
    expect(parsed.uniqueRows[0]?.name).toBe('2.1 «Волна»');
    expect(parsed.uniqueRows[0]?.commissionedAt).toBe('2020-06-01');
    expect(parsed.uniqueRows[0]?.warrantyEndsAt).toBeNull();
    expect(parsed.uniqueRows[1]?.name).toBe('2.1 «Волна» (1-й ПК)');
  });

  it('uses cached formula results and never treats the formula text as a date', () => {
    expect(
      parseImportedExcelDate({
        formula: 'IF(C2="","",EDATE(C2,60))',
        result: new Date(Date.UTC(2025, 5, 1)),
      }),
    ).toBe('2025-06-01');
    expect(
      parseImportedExcelDate({ formula: 'IF(C2="","",EDATE(C2,60))', result: null }),
    ).toBeNull();
    expect(parseImportedExcelDate({ formula: 'NOW()', result: '' })).toBeNull();
    expect(cachedExcelValue({ formula: 'A1+1', result: 42 })).toBe(42);
  });

  it('converts Excel serial numbers to ISO dates and keeps empty cells as null', () => {
    const serial = (Date.UTC(2024, 0, 15) - Date.UTC(1899, 11, 30)) / 86_400_000;
    expect(excelSerialToIsoDate(serial)).toBe('2024-01-15');
    expect(parseImportedExcelDate(serial)).toBe('2024-01-15');
    expect(parseImportedExcelDate(null)).toBeNull();
    expect(parseImportedExcelDate('   ')).toBeNull();
  });

  it('preserves Unicode quotes, ё and dashes when trimming only the edges', () => {
    const parsed = parseObjectsSheetMatrix(
      sheet([
        [
          '  13.1 «Лазурный – Ривьера» (1-й ПК – перенесённые виды работ)  ',
          '  ул. Л.Щемелёва, 11  ',
          null,
          null,
          '  Селевич Е.Г.  ',
        ],
      ]),
    );
    expect(parsed.uniqueRows[0]?.name).toBe(
      '13.1 «Лазурный – Ривьера» (1-й ПК – перенесённые виды работ)',
    );
    expect(parsed.uniqueRows[0]?.address).toBe('ул. Л.Щемелёва, 11');
    expect(parsed.uniqueRows[0]?.sourceResponsibleEngineerName).toBe('Селевич Е.Г.');
  });

  it('builds a stable source key that ignores Excel row order', () => {
    const first = buildSourceImportKey({
      name: '10.2 «Бора-Бора»',
      address: 'ул. Братская, 15',
      commissionedAt: null,
      warrantyEndsAt: null,
      sourceResponsibleEngineerName: null,
    });
    const second = buildSourceImportKey({
      name: '10.2 «Бора-Бора»',
      address: 'ул. Братская, 15',
      commissionedAt: null,
      warrantyEndsAt: null,
      sourceResponsibleEngineerName: null,
    });
    const other = buildSourceImportKey({
      name: '10.2 «Бора-Бора» (1-й ПК)',
      address: 'ул. Братская, 15',
      commissionedAt: null,
      warrantyEndsAt: null,
      sourceResponsibleEngineerName: null,
    });
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toHaveLength(64);
  });

  it('keeps full duplicate rows 32–33 as one object', () => {
    const parsed = parseObjectsSheetMatrix(
      sheet([
        ...Array.from({ length: 30 }, (_, index) => [
          `Объект ${index + 2}`,
          'адрес',
          null,
          null,
          null,
        ]),
        ['10.2 «Бора-Бора»', 'ул. Братская, 15', null, null, null],
        ['10.2 «Бора-Бора»', 'ул. Братская, 15', null, null, null],
        ['10.2 «Бора-Бора» (1-й ПК)', 'ул. Братская, 15', null, null, null],
      ]),
    );
    expect(
      parsed.uniqueRows.some((row) => row.sourceRow === 32 && row.name === '10.2 «Бора-Бора»'),
    ).toBe(true);
    expect(parsed.duplicates).toEqual([
      { keptSourceRow: 32, skippedSourceRow: 33, name: '10.2 «Бора-Бора»' },
    ]);
    expect(parsed.uniqueRows.filter((row) => row.name === '10.2 «Бора-Бора»')).toHaveLength(1);
    expect(parsed.uniqueRows).toHaveLength(32);
  });

  it('does not merge the main object, launch complex and transferred works', () => {
    const parsed = parseObjectsSheetMatrix(
      sheet([
        ['2.1 «Волна»', 'пр-т Мира, 1', null, null, null],
        ['2.1 «Волна» (1-й ПК)', 'пр-т Мира, 1', null, null, null],
        ['2.1 «Волна» (1-й ПК – перенесённые виды работ)', 'пр-т Мира, 1', null, null, null],
      ]),
    );
    expect(parsed.uniqueRows.map((row) => row.name)).toEqual([
      '2.1 «Волна»',
      '2.1 «Волна» (1-й ПК)',
      '2.1 «Волна» (1-й ПК – перенесённые виды работ)',
    ]);
    expect(new Set(parsed.uniqueRows.map((row) => row.sourceImportKey)).size).toBe(3);
  });

  it('blocks overwriting when one name maps to a different existing address', () => {
    const parsed = parseObjectsSheetMatrix(sheet([['ЖК Альфа', 'ул. Новая, 1', null, null, null]]));
    const plan = planPropertyObjectsImport(parsed, [
      {
        id: 'existing',
        name: 'ЖК Альфа',
        address: 'ул. Старая, 9',
        commissionedAt: null,
        warrantyEndsAt: null,
        sortOrder: 0,
        sourceResponsibleEngineerName: null,
        sourceSystem: null,
        sourceRow: null,
        sourceImportKey: null,
      },
    ]);
    expect(plan.create).toBe(0);
    expect(plan.update).toBe(0);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.reason).toMatch(/разными адресами/);
  });

  it('plans a second import as unchanged when source keys already match', () => {
    const parsed = parseObjectsSheetMatrix(
      sheet([['10.2 «Бора-Бора»', 'ул. Братская, 15', null, null, null]]),
    );
    const row = parsed.uniqueRows[0]!;
    const plan = planPropertyObjectsImport(parsed, [
      {
        id: 'imported',
        name: row.name,
        address: row.address,
        commissionedAt: row.commissionedAt,
        warrantyEndsAt: row.warrantyEndsAt,
        sortOrder: row.sourceRow,
        sourceResponsibleEngineerName: row.sourceResponsibleEngineerName,
        sourceSystem: OBJECTS_SOURCE_SYSTEM,
        sourceRow: row.sourceRow,
        sourceImportKey: row.sourceImportKey,
      },
    ]);
    expect(plan.create).toBe(0);
    expect(plan.update).toBe(0);
    expect(plan.unchanged).toBe(1);
    expect(plan.duplicatesSkipped).toBe(0);
  });

  it('classifies responsible engineer FIO without treating it as an assignment', () => {
    expect(classifyResponsibleEngineerName(null, [])).toBe('EMPTY');
    expect(
      classifyResponsibleEngineerName('Василевич М.В.', [
        {
          fullName: 'Дмитрий Орлов',
          role: 'RESPONSIBLE_ENGINEER',
          status: 'ACTIVE',
        },
      ]),
    ).toBe('UNRESOLVED');
    expect(
      classifyResponsibleEngineerName('Дмитрий Орлов', [
        { fullName: 'Дмитрий Орлов', role: 'RESPONSIBLE_ENGINEER', status: 'ACTIVE' },
      ]),
    ).toBe('LINKED');
    expect(
      classifyResponsibleEngineerName('Дмитрий Орлов', [
        { fullName: 'Дмитрий Орлов', role: 'RESPONSIBLE_ENGINEER', status: 'ACTIVE' },
        { fullName: 'Дмитрий Орлов', role: 'RESPONSIBLE_ENGINEER', status: 'ACTIVE' },
      ]),
    ).toBe('AMBIGUOUS');
  });

  it('stores imported calendar dates as UTC noon instants', () => {
    expect(calendarDateToUtcNoon('2020-06-01').toISOString()).toBe('2020-06-01T12:00:00.000Z');
  });
});
