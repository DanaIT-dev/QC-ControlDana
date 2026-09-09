import { describe, expect, it } from 'vitest';
import {
  ACTS_REGISTRY_SHEET_NAME,
  LEGACY_ACT_SOURCE_SYSTEM,
  canonicalizeLegacyActDocumentUrl,
  foldMatchKey,
  parseLegacyActsSheetMatrix,
  planLegacyActsImport,
  buildLegacyActSourceImportKey,
  buildLegacyDefectSourceImportKey,
  parseLegacyActStatus,
  slaEligibleForImportedAct,
  type LegacyActsCatalog,
} from './index';

const BITRIX_A = 'https://bitrix.bir.by/doc/act-a';
const BITRIX_B = 'https://bitrix.bir.by/doc/act-b';

function headerRow(): unknown[] {
  return [
    '№ акта',
    'Форма акта',
    'Статус',
    'Объект',
    'Адрес объекта',
    'Номер / наименование помещения',
    'Вид дефекта',
    'Заказчик',
    'Виновная организация',
    'Ответственный инженер',
    'Дата составления',
    'Срок устранения',
    'Претензия',
    'Срок устранения по претензии',
    'Третья сторона \n(предложение А)',
    'Цена (предложение А)',
    'Третья сторона \n(предложение Б)',
    'Цена (предложение Б)',
    'Третья сторона \n(предложение В)',
    'Цена (предложение В)',
    'Срок устранения третьей ст.',
    'Ссылка на документ',
    'Примечания',
  ];
}

function row(overrides: Record<number, unknown>): unknown[] {
  const cells: unknown[] = Array.from({ length: 23 }, () => null);
  cells[1] = 'С-23';
  cells[3] = '7.1 «Ибица»';
  cells[4] = { formula: 'IFERROR(VLOOKUP(D4,#REF!,2,FALSE),"")' };
  cells[5] = 'Лобби';
  cells[6] = 'Замокание / течь';
  cells[7] = 'ИООО «ДАНА АСТРА»';
  cells[8] = 'ООО «Сантехкомпания»';
  cells[9] = 'Соболь А.Т.';
  cells[10] = new Date(Date.UTC(2026, 6, 31));
  cells[11] = '5 рабочих дней';
  cells[21] = { text: BITRIX_A, hyperlink: BITRIX_A };
  for (const [index, value] of Object.entries(overrides)) {
    cells[Number(index)] = value;
  }
  return cells;
}

function sheet(dataRows: unknown[][]): unknown[][] {
  return [['Реестр'], headerRow(), [], ...dataRows];
}

function catalog(overrides: Partial<LegacyActsCatalog> = {}): LegacyActsCatalog {
  return {
    objects: [{ id: 'obj-1', name: '7.1 «Ибица»', address: 'пр-т Победителей, 1' }],
    organizations: [
      { id: 'org-c', officialName: 'ИООО «ДАНА АСТРА»', unp: null, roles: ['CUSTOMER'] },
      {
        id: 'org-l',
        officialName: 'ООО «Сантехкомпания»',
        unp: null,
        roles: ['LIABLE_CONTRACTOR'],
      },
    ],
    engineers: [
      {
        id: 'eng-1',
        fullName: 'Соболь Анжела Тадеушевна',
        role: 'RESPONSIBLE_ENGINEER',
        status: 'ACTIVE',
      },
      {
        id: 'eng-2',
        fullName: 'Богданович Ирина Александровна',
        role: 'RESPONSIBLE_ENGINEER',
        status: 'ACTIVE',
      },
    ],
    defectTypes: [
      { id: 'dt-1', name: 'Замокание / течь', active: true, sortOrder: 1 },
      { id: 'dt-2', name: 'Дефекты отделки', active: true, sortOrder: 2 },
    ],
    existingActs: [],
    existingDefects: [],
    ...overrides,
  };
}

describe('legacy acts import parser', () => {
  it('groups several rows of one URL into one act and merges liable orgs and engineers', () => {
    const parsed = parseLegacyActsSheetMatrix(
      sheet([
        row({ 5: 'Лобби', 8: 'ООО «Сантехкомпания»', 9: 'Соболь А.Т.' }),
        row({ 5: 'Лобби', 8: 'ООО «Новая»', 9: 'Богданович И.А.' }),
        row({ 5: 154, 6: 'Дефекты отделки', 11: new Date(Date.UTC(2026, 8, 1)) }),
      ]),
    );
    expect(parsed.sheetName).toBe(ACTS_REGISTRY_SHEET_NAME);
    expect(parsed.sourceRows).toBe(3);
    expect(parsed.uniqueDocumentUrls).toBe(1);
    expect(parsed.repeatedUrlGroups).toBe(1);
    expect(parsed.groupedActs).toHaveLength(1);
    expect(parsed.groupedActs[0]?.defects).toHaveLength(2);
    const lobby = parsed.groupedActs[0]?.defects.find((item) => item.location === 'Лобби');
    expect(lobby?.liableOrganizationNames).toEqual(['ООО «Сантехкомпания»', 'ООО «Новая»']);
    expect(lobby?.engineerNames).toEqual(['Соболь А.Т.', 'Богданович И.А.']);
    expect(lobby?.plannedDeadline).toBeNull();
    expect(lobby?.deadlineRaw).toBe('5 рабочих дней');
    const room = parsed.groupedActs[0]?.defects.find((item) => item.location === '154');
    expect(room?.plannedDeadline).toBe('2026-09-01');
  });

  it('treats different URLs as different acts even when numbers and objects match', () => {
    const parsed = parseLegacyActsSheetMatrix(
      sheet([
        row({ 0: '12', 21: { text: BITRIX_A, hyperlink: BITRIX_A } }),
        row({ 0: '12', 21: { text: BITRIX_B, hyperlink: BITRIX_B } }),
      ]),
    );
    expect(parsed.groupedActs).toHaveLength(2);
    expect(parsed.groupedActs[0]?.actNumberRaw).toBe('12');
    expect(parsed.groupedActs[1]?.actNumberRaw).toBe('12');
    expect(parsed.groupedActs[0]?.sourceImportKey).not.toBe(parsed.groupedActs[1]?.sourceImportKey);
  });

  it('maps empty status, В работе, unset and textual deadlines, and dash location', () => {
    const parsed = parseLegacyActsSheetMatrix(
      sheet([
        row({ 2: null, 5: '–', 11: 'Не установлен' }),
        row({
          2: 'В работе',
          21: { text: BITRIX_B, hyperlink: BITRIX_B },
          11: new Date(Date.UTC(2026, 7, 15)),
        }),
      ]),
    );
    expect(parsed.groupedActs[0]?.status).toBe('IMPORTED_UNSPECIFIED');
    expect(parsed.groupedActs[0]?.defects[0]?.location).toBeNull();
    expect(parsed.groupedActs[0]?.defects[0]?.plannedDeadline).toBeNull();
    expect(parsed.groupedActs[0]?.defects[0]?.deadlineRaw).toBe('Не установлен');
    expect(parsed.groupedActs[1]?.status).toBe('IN_PROGRESS');
    expect(parsed.groupedActs[1]?.defects[0]?.plannedDeadline).toBe('2026-08-15');
  });

  it('rejects non-bitrix URLs and does not treat address formulas as values', () => {
    const parsed = parseLegacyActsSheetMatrix(
      sheet([
        row({
          21: { text: 'javascript:alert(1)', hyperlink: 'javascript:alert(1)' },
        }),
      ]),
    );
    expect(parsed.invalidRows.some((item) => item.field === 'documentUrl')).toBe(true);
    expect(canonicalizeLegacyActDocumentUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeLegacyActDocumentUrl('file:///etc/passwd')).toBeNull();
    expect(canonicalizeLegacyActDocumentUrl('data:text/html,hi')).toBeNull();
    expect(canonicalizeLegacyActDocumentUrl('https://evil.example/doc')).toBeNull();
    expect(canonicalizeLegacyActDocumentUrl(BITRIX_A)).toBe(BITRIX_A);
    expect(parsed.brokenAddressFormulas).toBe(1);
  });

  it('blocks grouping when object or form conflicts inside one URL', () => {
    const parsed = parseLegacyActsSheetMatrix(
      sheet([row({ 3: '7.1 «Ибица»' }), row({ 3: '7.2 «Санторини»' })]),
    );
    expect(parsed.groupingConflicts).toHaveLength(1);
    expect(parsed.groupedActs).toHaveLength(0);
  });
});

describe('legacy acts import plan', () => {
  it('creates expected acts and defects and reports unmatched engineers', () => {
    const parsed = parseLegacyActsSheetMatrix(
      sheet([
        row({ 8: '–' }),
        row({
          8: 'ООО «Сантехкомпания»',
          9: 'Лазарчик Е.В.',
          21: { text: BITRIX_B, hyperlink: BITRIX_B },
        }),
      ]),
    );
    const plan = planLegacyActsImport(parsed, catalog());
    expect(plan.actsToCreate).toBe(2);
    expect(plan.defectsToCreate).toBe(2);
    expect(plan.blockingIssues.some((item) => item.includes('Лазарчик'))).toBe(false);
    expect(plan.warnings.some((item) => item.includes('Лазарчик'))).toBe(true);
    expect(plan.unresolvedEngineerLinksToCreate).toBe(1);
    expect(plan.liableOrganizationsToCreate).toEqual([]);
    expect(slaEligibleForImportedAct({ status: 'IMPORTED_UNSPECIFIED', startedAt: null })).toBe(
      false,
    );
    expect(parseLegacyActStatus(null)).toBe('IMPORTED_UNSPECIFIED');
  });

  it('returns unchanged on repeat import and conflicts when payload changes', () => {
    const parsed = parseLegacyActsSheetMatrix(sheet([row({})]));
    const actKey = buildLegacyActSourceImportKey(BITRIX_A);
    const defectKey = buildLegacyDefectSourceImportKey({
      actSourceImportKey: actKey,
      location: 'Лобби',
      defectTypeName: 'Замокание / течь',
      deadlineRaw: '5 рабочих дней',
    });
    const existingCatalog = catalog({
      existingActs: [
        {
          id: 'act-1',
          sourceSystem: LEGACY_ACT_SOURCE_SYSTEM,
          sourceImportKey: actKey,
          formCode: 'S23',
          issuedOn: '2026-07-31',
          objectId: 'obj-1',
          customerOrganizationId: 'org-c',
          status: 'IMPORTED_UNSPECIFIED',
          officialNumber: null,
          sourceActNumberRaw: null,
          sourceStatusRaw: null,
          sourceExternalUrl: BITRIX_A,
          sourceRows: [4],
        },
      ],
      existingDefects: [
        {
          id: 'def-1',
          actId: 'act-1',
          sourceSystem: LEGACY_ACT_SOURCE_SYSTEM,
          sourceImportKey: defectKey,
          location: 'Лобби',
          defectTypeName: 'Замокание / течь',
          plannedDeadline: null,
          sourceDeadlineRaw: '5 рабочих дней',
          liableOrganizationIds: ['org-l'],
          engineerIds: ['eng-1'],
          unresolvedEngineerKeys: [],
        },
      ],
    });
    const repeat = planLegacyActsImport(parsed, existingCatalog);
    expect(repeat.actsToCreate).toBe(0);
    expect(repeat.defectsToCreate).toBe(0);
    expect(repeat.actsUnchanged).toBe(1);
    expect(repeat.defectsUnchanged).toBe(1);
    expect(repeat.payloadConflicts).toHaveLength(0);

    const changed = parseLegacyActsSheetMatrix(sheet([row({ 1: 'С-1' })]));
    const conflict = planLegacyActsImport(changed, existingCatalog);
    expect(conflict.payloadConflicts.length).toBeGreaterThan(0);
    expect(conflict.blockingIssues.some((item) => item.includes('Конфликт'))).toBe(true);
  });

  it('blocks ambiguous object matching and does not invent work types', () => {
    const parsed = parseLegacyActsSheetMatrix(sheet([row({})]));
    const plan = planLegacyActsImport(
      parsed,
      catalog({
        objects: [
          { id: 'obj-1', name: '7.1 «Ибица»', address: 'a' },
          { id: 'obj-2', name: '7.1 «Ибица»', address: 'b' },
        ],
      }),
    );
    expect(plan.blockingIssues.some((item) => item.includes('Неоднозначный объект'))).toBe(true);
    expect(foldMatchKey('Ёлка «Тест»')).toBe(foldMatchKey('елка "тест"'));
  });

  it('blocks apply when several active engineers match the same Excel name', () => {
    const parsed = parseLegacyActsSheetMatrix(sheet([row({ 9: 'Иванов П.' })]));
    const plan = planLegacyActsImport(
      parsed,
      catalog({
        engineers: [
          {
            id: 'eng-p1',
            fullName: 'Иванов Пётр',
            role: 'RESPONSIBLE_ENGINEER',
            status: 'ACTIVE',
          },
          {
            id: 'eng-p2',
            fullName: 'Иванов Павел',
            role: 'RESPONSIBLE_ENGINEER',
            status: 'ACTIVE',
          },
        ],
      }),
    );
    expect(plan.blockingIssues.some((item) => item.includes('Неоднозначный инженер'))).toBe(true);
    expect(plan.actsToCreate).toBe(1);
  });
});
