import { describe, expect, it } from 'vitest';
import { DuplicateDirectoryRecordError } from './errors';
import { generateCodedReferenceCode } from './directory-codes';
import {
  assertOrganizationNotDuplicate,
  missingOrganizationDetailFields,
  organizationCreateToast,
  organizationDetailsComplete,
  organizationIncompleteNotificationBody,
  organizationIncompleteOccurrenceKey,
} from './organization-completeness';

describe('organization completeness', () => {
  it('treats name-only records as incomplete and lists existing fields', () => {
    const input = { officialName: 'ООО Тест' };
    expect(organizationDetailsComplete(input)).toBe(false);
    expect(missingOrganizationDetailFields(input)).toEqual([
      'unp',
      'postalAddress',
      'email',
      'phone',
      'contactPerson',
    ]);
    expect(
      organizationIncompleteNotificationBody({ officialName: 'ООО Тест', missingFields: ['unp'] }),
    ).toBe('Заполните подробные данные организации «ООО Тест». Не заполнены: УНП.');
    expect(
      organizationIncompleteNotificationBody({
        officialName: 'ООО Вина',
        missingFields: ['unp', 'postalAddress'],
        liable: true,
      }),
    ).toBe('Заполните подробные данные виновной организации «ООО Вина». Не заполнены: УНП, адрес.');
    expect(organizationCreateToast(true)).toBe(
      'Организация добавлена. Заполните подробные данные в справочнике.',
    );
    expect(organizationIncompleteOccurrenceKey('org-1')).toBe(
      'ORGANIZATION_DETAILS_INCOMPLETE:org-1',
    );
  });

  it('blocks normalized name and UNP duplicates and exposes the existing record', () => {
    const existing = [
      { id: '1', officialName: 'ООО Ромашка', unp: '100000001' },
      { id: '2', officialName: 'Другая', unp: null },
    ];
    expect(() =>
      assertOrganizationNotDuplicate({ officialName: '  ооо ромашка ' }, existing),
    ).toThrow(DuplicateDirectoryRecordError);
    try {
      assertOrganizationNotDuplicate({ officialName: 'Новая', unp: '100 000 001' }, existing);
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateDirectoryRecordError);
      expect((error as DuplicateDirectoryRecordError).existing).toEqual({
        id: '1',
        label: 'ООО Ромашка',
      });
    }
    expect(() =>
      assertOrganizationNotDuplicate({ officialName: 'Уникальная', unp: '100000002' }, existing),
    ).not.toThrow();
  });
});

describe('coded reference codes', () => {
  it('generates unique codes without colliding on folded duplicates', () => {
    const first = generateCodedReferenceCode('WT', 'Окна', ['WT_001_OKNA'], 1);
    expect(first.startsWith('WT_')).toBe(true);
    expect(first).not.toBe('WT_001_OKNA');
    const defect = generateCodedReferenceCode('DT', 'Течь', [], 22);
    expect(defect.startsWith('DT_')).toBe(true);
    expect(defect.length).toBeLessThanOrEqual(40);
  });
});
