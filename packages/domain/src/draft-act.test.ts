import { describe, expect, it } from 'vitest';
import { ACT_DOCUMENT_MAX_BYTES } from './attachments';
import { ValidationError } from './errors';
import { parseOptionalCalendarDate } from './reference';
import {
  REGISTRY_PAGE_SIZES,
  DEFAULT_REGISTRY_PAGE_SIZE,
  parseRegistryListQuery,
} from './registry-query';
import { formatPersonShort } from './person-name';
import {
  actDocumentWithinLimit,
  addressUsesClipping,
  alphabeticalSortKey,
  coercePageSize,
  compareAlphabeticalNames,
  compareNaturalNames,
  draftStartGaps,
  isAllowedActDocumentName,
  isBlankDraftDefect,
  naturalSortKey,
  normalizeDraftLocation,
  singleResponsibleEngineerId,
} from './draft-act';

describe('draft acts', () => {
  it('treats a whitespace string as an empty draft value', () => {
    expect(normalizeDraftLocation('   ')).toBeNull();
    expect(normalizeDraftLocation('  холл  ')).toBe('холл');
  });

  it('keeps an empty date empty and rejects an impossible date', () => {
    expect(parseOptionalCalendarDate('', 'issuedOn')).toBeNull();
    expect(parseOptionalCalendarDate(null, 'issuedOn')).toBeNull();
    expect(() => parseOptionalCalendarDate('2026-13-01', 'issuedOn')).toThrow(ValidationError);
    expect(() => parseOptionalCalendarDate('2026-02-31', 'plannedDeadline')).toThrow(
      ValidationError,
    );
  });

  it('does not persist a completely empty defect card', () => {
    expect(
      isBlankDraftDefect({
        location: '  ',
        claimDetails: '',
        notes: null,
        defectTypeId: null,
        responsibleEngineerIds: [],
        liableOrganizationIds: [],
        plannedDeadline: '',
      }),
    ).toBe(true);
    expect(isBlankDraftDefect({ location: 'Кухня' })).toBe(false);
  });

  it('accepts a partial defect and lists only the data needed to start work', () => {
    expect(
      draftStartGaps({
        objectId: null,
        customerOrganizationId: null,
        issuedOn: null,
        formCode: null,
        defects: [{ defectTypeId: null }],
      }),
    ).toEqual(['объект', 'заказчик', 'дата акта', 'форма акта', 'вид дефекта у каждого дефекта']);
    expect(
      draftStartGaps({
        objectId: 'object',
        customerOrganizationId: 'customer',
        issuedOn: '2026-10-16',
        formCode: 'S1',
        defects: [{ defectTypeId: 'type' }],
      }),
    ).toEqual([]);
  });

  it('allows one responsible engineer and rejects two', () => {
    expect(singleResponsibleEngineerId(['engineer-1'], undefined)).toBe('engineer-1');
    expect(singleResponsibleEngineerId([], null)).toBeNull();
    expect(() => singleResponsibleEngineerId(['a', 'b'], undefined)).toThrow(ValidationError);
  });
});

describe('person and sort keys', () => {
  it('formats a short name and omits a missing patronymic', () => {
    expect(
      formatPersonShort({ lastName: 'Андрушевич', firstName: 'Сергей', middleName: 'Николаевич' }),
    ).toBe('Андрушевич С.Н.');
    expect(formatPersonShort({ lastName: 'Иванов', firstName: 'Пётр', middleName: null })).toBe(
      'Иванов П.',
    );
    expect(formatPersonShort({ lastName: 'Иванов', firstName: 'Пётр', middleName: ' ' })).toBe(
      'Иванов П.',
    );
  });

  it('sorts object names by the numbers inside them', () => {
    const names = ['Дом 12.2', 'Дом 2', 'Дом 10', 'Дом 1', 'Дом 12.1', 'Дом 11', 'Дом 3'];
    expect([...names].sort(compareNaturalNames)).toEqual([
      'Дом 1',
      'Дом 2',
      'Дом 3',
      'Дом 10',
      'Дом 11',
      'Дом 12.1',
      'Дом 12.2',
    ]);
    expect(naturalSortKey('Дом 2') < naturalSortKey('Дом 10')).toBe(true);
  });

  it('sorts defect names alphabetically and folds ё to е', () => {
    expect(alphabeticalSortKey('  Ёлка   трещина ')).toBe(alphabeticalSortKey('елка трещина'));
    expect(compareAlphabeticalNames('ёжик', 'ель')).toBeLessThan(0);
    expect(['трещина', 'Ёмкость', 'абсцесс', 'ель'].sort(compareAlphabeticalNames)).toEqual([
      'абсцесс',
      'ель',
      'Ёмкость',
      'трещина',
    ]);
  });
});

describe('page size and documents', () => {
  it('keeps a supported page size and replaces an unsupported one', () => {
    expect(coercePageSize('50', REGISTRY_PAGE_SIZES, DEFAULT_REGISTRY_PAGE_SIZE)).toBe(50);
    expect(coercePageSize('30', REGISTRY_PAGE_SIZES, DEFAULT_REGISTRY_PAGE_SIZE)).toBe(50);
    expect(coercePageSize('50abc', REGISTRY_PAGE_SIZES, DEFAULT_REGISTRY_PAGE_SIZE)).toBe(50);
    expect(parseRegistryListQuery({ pageSize: '30' }).pageSize).toBe(50);
  });

  it('accepts act documents up to 10 MiB and rejects other types', () => {
    expect(actDocumentWithinLimit(ACT_DOCUMENT_MAX_BYTES)).toBe(true);
    expect(actDocumentWithinLimit(ACT_DOCUMENT_MAX_BYTES + 1)).toBe(false);
    expect(isAllowedActDocumentName('акт.pdf')).toBe(true);
    expect(isAllowedActDocumentName('смета.xlsx')).toBe(true);
    expect(isAllowedActDocumentName('макрос.docm')).toBe(false);
    expect(isAllowedActDocumentName('payload.exe')).toBe(false);
  });

  it('does not treat a wrapping address as clipped', () => {
    expect(addressUsesClipping('whitespace-normal break-words [overflow-wrap:anywhere]')).toBe(
      false,
    );
    expect(addressUsesClipping('max-w-[28rem] truncate')).toBe(true);
  });
});
