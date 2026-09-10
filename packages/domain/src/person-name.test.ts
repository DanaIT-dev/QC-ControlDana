import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors';
import {
  composeOfficialFullName,
  comparePersonNames,
  confirmTwoTokenOfficialName,
  formatPersonFull,
  formatPersonShort,
  parsePersonNameForForm,
  parsePersonNameInput,
  parseStoredOfficialPersonName,
  personMatchesSearch,
  personNameFromParts,
  personNameWriteFields,
  reportAmbiguousLegacyPersonName,
  resolveOfficialFullName,
} from './person-name';

describe('person name', () => {
  it('composes last name, first name and optional middle name', () => {
    expect(
      composeOfficialFullName(
        parsePersonNameInput({ lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович' }),
      ),
    ).toBe('Иванов Иван Иванович');
    expect(
      composeOfficialFullName(
        parsePersonNameInput({
          lastName: 'Петрова-Смирнова',
          firstName: 'Анна',
          middleName: '   ',
        }),
      ),
    ).toBe('Петрова-Смирнова Анна');
    expect(
      parsePersonNameInput({ lastName: 'Иванов', firstName: 'Пётр', middleName: null }).middleName,
    ).toBe(null);
  });

  it('formats compact and full names without leftover spaces or dots', () => {
    expect(
      formatPersonShort(
        parsePersonNameInput({
          lastName: 'Лазарчик',
          firstName: 'Елена',
          middleName: 'Викторовна',
        }),
      ),
    ).toBe('Лазарчик Е.В.');
    expect(
      formatPersonShort(
        personNameFromParts({ lastName: 'Ковалева', firstName: 'Мария', middleName: null }),
      ),
    ).toBe('Ковалева М.');
    expect(
      formatPersonShort(
        parsePersonNameInput({ lastName: 'Иванов', firstName: 'Пётр', middleName: null }),
      ),
    ).toBe('Иванов П.');
    expect(
      formatPersonShort(
        parsePersonNameInput({
          lastName: 'Петрова-Смирнова',
          firstName: 'Анна',
          middleName: 'Ивановна',
        }),
      ),
    ).toBe('Петрова-Смирнова А.И.');
    expect(formatPersonShort('Лазарчик Елена Викторовна')).toBe('Лазарчик Е.В.');
    expect(formatPersonShort('Лазарчик Е.В.')).toBe('Лазарчик Е.В.');
    expect(formatPersonShort('Ёлкин Пётр Сергеевич')).toBe('Ёлкин П.С.');
    expect(
      resolveOfficialFullName({ lastName: 'Иванов', firstName: 'Пётр', middleName: '  ' }),
    ).toBe('Иванов Пётр');
    expect(
      formatPersonFull({ lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович' }),
    ).toBe('Иванов Иван Иванович');
    expect(formatPersonFull({ lastName: 'Иванов', firstName: 'Пётр', middleName: null })).toBe(
      'Иванов Пётр',
    );
    expect(personMatchesSearch('Лазарчик Елена Викторовна', 'Лазарчик Е.В.')).toBe(true);
    expect(personMatchesSearch('Лазарчик Елена Викторовна', 'Лазарчик Е.')).toBe(true);
    expect(personMatchesSearch('Иванов Пётр', 'Иванов П')).toBe(true);
    expect(personMatchesSearch('Ёлкин Егор Сергеевич', 'елкин')).toBe(true);
    expect(
      comparePersonNames(
        { lastName: 'Иванов', firstName: 'Пётр', middleName: null },
        { lastName: 'Иванов', firstName: 'Пётр', middleName: 'Сергеевич' },
      ),
    ).toBeLessThan(0);
  });

  it('does not silently split a two-token legacy name', () => {
    expect(parseStoredOfficialPersonName('Мария Ковалева')).toEqual({
      ok: false,
      reason: 'двухсловное ФИО требует подтверждения структуры',
    });
    expect(parseStoredOfficialPersonName('Ковалева Мария')).toEqual({
      ok: false,
      reason: 'двухсловное ФИО требует подтверждения структуры',
    });
    expect(reportAmbiguousLegacyPersonName('Мария Ковалева')).toBe(
      'двухсловное ФИО требует подтверждения структуры',
    );
    expect(() => personNameWriteFields('Мария Ковалева')).toThrow(ValidationError);
    expect(parsePersonNameForForm('Мария Ковалева')).toEqual({
      lastName: 'Мария Ковалева',
      firstName: '',
      middleName: null,
    });
    expect(formatPersonShort('Мария Ковалева')).toBe('Мария Ковалева');
  });

  it('applies an explicit two-token mapping and formats without a patronymic', () => {
    const parts = confirmTwoTokenOfficialName('Мария Ковалева', {
      lastName: 'Ковалева',
      firstName: 'Мария',
    });
    expect(parts).toEqual({ lastName: 'Ковалева', firstName: 'Мария', middleName: null });
    expect(formatPersonShort(parts)).toBe('Ковалева М.');
    expect(formatPersonFull(parts)).toBe('Ковалева Мария');
    expect(
      personNameWriteFields('Мария Ковалева', {
        confirmTwoToken: { lastName: 'Ковалева', firstName: 'Мария' },
      }),
    ).toEqual({
      lastName: 'Ковалева',
      firstName: 'Мария',
      middleName: null,
      fullName: 'Ковалева Мария',
    });
    expect(() =>
      confirmTwoTokenOfficialName('Мария Ковалева', {
        lastName: 'Иванов',
        firstName: 'Пётр',
      }),
    ).toThrow(ValidationError);
  });

  it('parses three official tokens, hyphenated last names and yo', () => {
    expect(parseStoredOfficialPersonName('Иванова Ирина Александровна')).toEqual({
      ok: true,
      parts: { lastName: 'Иванова', firstName: 'Ирина', middleName: 'Александровна' },
    });
    expect(parseStoredOfficialPersonName('Петрова-Смирнова Анна-Мария Ивановна')).toEqual({
      ok: true,
      parts: {
        lastName: 'Петрова-Смирнова',
        firstName: 'Анна-Мария',
        middleName: 'Ивановна',
      },
    });
    expect(parseStoredOfficialPersonName('Ёлкин Пётр Сергеевич')).toEqual({
      ok: true,
      parts: { lastName: 'Ёлкин', firstName: 'Пётр', middleName: 'Сергеевич' },
    });
    expect(parseStoredOfficialPersonName('Иванов Иван Иванович младший').ok).toBe(false);
    expect(parseStoredOfficialPersonName('Иванов Иван Петров').ok).toBe(false);
  });

  it('rejects empty names, control characters and extra spaces inside a part', () => {
    expect(() =>
      parsePersonNameInput({ lastName: '  ', firstName: 'Иван', middleName: null }),
    ).toThrow(ValidationError);
    expect(() =>
      parsePersonNameInput({ lastName: 'Иванов', firstName: '', middleName: null }),
    ).toThrow(ValidationError);
    expect(() =>
      parsePersonNameInput({ lastName: 'Ива\u0001нов', firstName: 'Иван', middleName: null }),
    ).toThrow(ValidationError);
  });

  it('does not split an existing full name when the token count is unsafe', () => {
    const parsed = parsePersonNameForForm('Иванов Иван Иванович младший');
    expect(parsed.lastName).toBe('Иванов Иван Иванович младший');
    expect(parsed.firstName).toBe('');
  });
});
