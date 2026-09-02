import { describe, expect, it } from 'vitest';
import { APPROVED_DEFECT_TYPES_SOURCE, APPROVED_DEFECT_TYPES_V1 } from './approved-defect-types';
import {
  mergeWorkTypeSources,
  parseActOrganizationRoles,
  parseOrganizationWorkTypeColumn,
  parseOrganizationsMatrix,
  parseWorkTypeValues,
  planApprovedDefectTypesSync,
  planCodedDirectorySync,
  planOrganizationSync,
} from './directories-import';
import { parseManualObjectInput, assertManualObjectNotDuplicate } from './manual-object';
import { DuplicateValueError, ValidationError } from './errors';

describe('approved defect types', () => {
  it('contains exactly 22 approved names in the required order', () => {
    expect(APPROVED_DEFECT_TYPES_V1).toHaveLength(22);
    expect(APPROVED_DEFECT_TYPES_SOURCE).toBe('APPROVED_DEFECT_TYPES_V1');
    expect(APPROVED_DEFECT_TYPES_V1[0]?.name).toBe(
      'Дефекты блоков подпорных стен / крылец / приямков',
    );
    expect(APPROVED_DEFECT_TYPES_V1.map((item) => item.sortOrder)).toEqual(
      Array.from({ length: 22 }, (_, index) => index + 1),
    );
    expect(new Set(APPROVED_DEFECT_TYPES_V1.map((item) => item.name)).size).toBe(22);
    expect(new Set(APPROVED_DEFECT_TYPES_V1.map((item) => item.code)).size).toBe(22);
  });

  it('reuses exact name matches and reports unexpected rows without deleting them', () => {
    const existing = [
      {
        id: '1',
        code: 'SEWER',
        name: 'Дефекты канализации',
        sortOrder: 99,
        active: true,
      },
      {
        id: 'x',
        code: 'ARCHIVED_DEFECT',
        name: 'Архивный вид дефекта (демо)',
        sortOrder: 99,
        active: false,
      },
    ];
    const plan = planApprovedDefectTypesSync(existing);
    expect(plan.approvedCount).toBe(22);
    expect(plan.create).toBe(21);
    expect(plan.update).toBe(1);
    expect(plan.unexpected).toEqual([
      { id: 'x', name: 'Архивный вид дефекта (демо)', code: 'ARCHIVED_DEFECT' },
    ]);
    expect(plan.items.find((item) => item.name === 'Дефекты канализации')?.existingId).toBe('1');
  });

  it('is unchanged when the 22 approved rows already match', () => {
    const existing = APPROVED_DEFECT_TYPES_V1.map((item, index) => ({
      id: String(index + 1),
      code: item.code,
      name: item.name,
      sortOrder: item.sortOrder,
      active: true,
    }));
    const plan = planApprovedDefectTypesSync(existing);
    expect(plan.create).toBe(0);
    expect(plan.update).toBe(0);
    expect(plan.unchanged).toBe(22);
    expect(plan.unexpected).toHaveLength(0);
    expect(plan.exactOrder).toBe(true);
  });
});

describe('work types parser', () => {
  it('skips blanks, keeps exact text and first-seen order, and does not fuzzy-merge', () => {
    const parsed = parseWorkTypeValues([
      'Виды работ',
      'Окна',
      '  Фасад  ',
      '',
      'Окна',
      'Окна (поставщик)',
      'Исключен из ЕГР',
    ]);
    expect(parsed.nonemptyRows).toBe(6);
    expect(parsed.blankRows).toBe(1);
    expect(parsed.exactDuplicates).toBe(1);
    expect(parsed.rows.map((row) => row.name)).toEqual(['Окна', 'Фасад', 'Окна (поставщик)']);
  });

  it('falls back to organization work-type column when the sheet is empty', () => {
    const merged = mergeWorkTypeSources(
      ['Виды работ', ''],
      parseOrganizationWorkTypeColumn([
        ['Наименование организации', 'Вид выполняемых работ'],
        ['ООО «Окна»', 'Окна (поставщик)'],
        ['ООО «Фасад»', 'Фасад'],
        ['ООО «Повтор»', 'Окна (поставщик)'],
      ]),
    );
    expect(merged.sheet).toBe('Организации');
    expect(merged.rows.map((row) => row.name)).toEqual(['Окна (поставщик)', 'Фасад']);
  });

  it('does not create coded duplicates for an identical catalog', () => {
    const incoming = [
      { sortOrder: 1, code: 'WT_01_OKNA', name: 'Окна' },
      { sortOrder: 2, code: 'WT_02_FASAD', name: 'Фасад' },
    ];
    const existing = incoming.map((item, index) => ({
      id: String(index),
      code: item.code,
      name: item.name,
      sortOrder: item.sortOrder,
      active: true,
    }));
    const plan = planCodedDirectorySync(existing, incoming);
    expect(plan.create).toBe(0);
    expect(plan.update).toBe(0);
    expect(plan.unchanged).toBe(2);
  });
});

describe('organizations parser', () => {
  it('imports only organizations needed for the act and skips people or placeholders', () => {
    const actRoles = parseActOrganizationRoles([
      ['Заказчик', 'Виновная организация'],
      ['ИООО «ДАНА АСТРА»', 'ООО «Окна»'],
      ['ИООО «ДАНА АСТРА»', 'Не установлена'],
    ]);
    expect(actRoles.customers).toEqual(['ИООО «ДАНА АСТРА»']);
    expect(actRoles.liable).toEqual(['ООО «Окна»']);
    const parsed = parseOrganizationsMatrix(
      [
        [
          '№ п/п',
          'Наименование организации',
          'Статус',
          'Вид выполняемых работ',
          'УНП/ИНН',
          'Почтовый адрес',
          'email',
          'Контактное лицо',
          'телефон',
        ],
        [1, 'ИООО «ДАНА АСТРА»', 'Действующий', 'Заказчик', '123456789', '', '', '', ''],
        [
          2,
          'ООО «Окна»',
          'Действующий',
          'Окна',
          '',
          'ул. Оконная, 1',
          'windows@example.test',
          '',
          '',
        ],
        [3, 'Собственник (Иванов И.И.)', 'Действующий', '—', '', '', '', '', ''],
        [4, 'ООО «Лишняя»', 'Действующий', 'Фасад', '', '', '', '', ''],
      ],
      actRoles,
    );
    expect(parsed.items.map((item) => item.officialName)).toEqual([
      'ИООО «ДАНА АСТРА»',
      'ООО «Окна»',
    ]);
    expect(parsed.items[0]?.roles).toEqual(['CUSTOMER']);
    expect(parsed.items[1]?.roles).toEqual(['LIABLE_CONTRACTOR']);
    expect(parsed.items[0]?.unp).toBe('123456789');
    expect(parsed.items[0]?.postalAddress).toBeNull();
    expect(parsed.skipped.some((item) => item.reason === 'placeholder_or_person')).toBe(true);
    expect(parsed.skipped.some((item) => item.reason === 'not_required_for_act')).toBe(true);
  });

  it('updates an existing organization instead of creating a duplicate', () => {
    const incoming = parseOrganizationsMatrix(
      [
        ['Наименование организации', 'УНП/ИНН'],
        ['ООО «Окна»', '111222333'],
      ],
      { customers: [], liable: ['ООО «Окна»'] },
    ).items;
    const plan = planOrganizationSync(
      [
        {
          id: 'org-1',
          officialName: 'ООО «Окна»',
          unp: null,
          postalAddress: null,
          email: null,
          phone: null,
          contactPerson: null,
          active: true,
          roles: [],
        },
      ],
      incoming,
    );
    expect(plan.create).toBe(0);
    expect(plan.update).toBe(1);
    expect(plan.items[0]?.existingId).toBe('org-1');
  });
});

describe('manual object input', () => {
  it('trims fields, stores empty address as null and rejects inverted dates', () => {
    const parsed = parseManualObjectInput({
      name: '  ЖК Волна  ',
      address: '   ',
      commissionedAt: '2024-01-15',
      warrantyEndsAt: '2029-01-15',
      responsibleEngineerName: ' Василевич М.В. ',
    });
    expect(parsed.name).toBe('ЖК Волна');
    expect(parsed.address).toBeNull();
    expect(parsed.responsibleEngineerName).toBe('Василевич М.В.');
    expect(() =>
      parseManualObjectInput({
        name: 'ЖК Волна',
        commissionedAt: '2024-01-15',
        warrantyEndsAt: '2023-12-31',
      }),
    ).toThrow(ValidationError);
  });

  it('treats only the same name and address as a duplicate', () => {
    const existing = [{ name: 'ЖК Волна', address: 'пр-т Мира, 1' }];
    expect(() =>
      assertManualObjectNotDuplicate({ name: 'ЖК Волна', address: 'пр-т Мира, 1' }, existing),
    ).toThrow(DuplicateValueError);
    expect(() =>
      assertManualObjectNotDuplicate({ name: 'ЖК Волна', address: 'другой адрес' }, existing),
    ).not.toThrow();
    expect(() =>
      assertManualObjectNotDuplicate({ name: 'Другой объект', address: 'пр-т Мира, 1' }, existing),
    ).not.toThrow();
  });
});
