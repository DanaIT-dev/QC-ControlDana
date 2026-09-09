import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors';
import {
  composeOfficialFullName,
  comparePersonNames,
  formatPersonFull,
  formatPersonShort,
  parsePersonNameForForm,
  parsePersonNameInput,
  parseStoredOfficialPersonName,
  personMatchesSearch,
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
        parsePersonNameInput({
          lastName: 'Головач',
          firstName: 'Олег',
          middleName: 'Владимирович',
        }),
      ),
    ).toBe('Головач О.В.');
    expect(
      formatPersonShort(
        parsePersonNameInput({ lastName: 'Иванов', firstName: 'Пётр', middleName: null }),
      ),
    ).toBe('Иванов П.');
    expect(
      formatPersonShort(
        parsePersonNameInput({ lastName: 'Смирнова', firstName: 'Анна', middleName: '' }),
      ),
    ).toBe('Смирнова А.');
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
    expect(formatPersonShort('Анна Смирнова')).toBe('Анна С.');
    expect(formatPersonShort('Иванов Пётр')).toBe('Иванов П.');
    expect(formatPersonShort('Дмитрий Орлов')).toBe('Дмитрий О.');
    expect(formatPersonShort({ lastName: 'Смирнова', firstName: 'Анна', middleName: null })).toBe(
      'Смирнова А.',
    );
    expect(formatPersonShort('Лазарчик Е.В.')).toBe('Лазарчик Е.В.');
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
    expect(personMatchesSearch('Ёлкин Егор', 'елкин')).toBe(true);
    expect(
      comparePersonNames(
        { lastName: 'Иванов', firstName: 'Пётр', middleName: null },
        { lastName: 'Иванов', firstName: 'Пётр', middleName: 'Сергеевич' },
      ),
    ).toBeLessThan(0);
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

  it('parses stored official names without guessing given-name order or unverified patronymics', () => {
    expect(parseStoredOfficialPersonName('Богданович Ирина Александровна')).toEqual({
      ok: true,
      parts: { lastName: 'Богданович', firstName: 'Ирина', middleName: 'Александровна' },
    });
    expect(parseStoredOfficialPersonName('Видевич Светлана-Богумила Александровна')).toEqual({
      ok: true,
      parts: {
        lastName: 'Видевич',
        firstName: 'Светлана-Богумила',
        middleName: 'Александровна',
      },
    });
    expect(parseStoredOfficialPersonName('Павел Болутенко')).toEqual({
      ok: true,
      parts: { lastName: 'Павел', firstName: 'Болутенко', middleName: null },
    });
    expect(formatPersonFull({ lastName: 'Павел', firstName: 'Болутенко', middleName: null })).toBe(
      'Павел Болутенко',
    );
    expect(parseStoredOfficialPersonName('Иванов Иван Иванович младший').ok).toBe(false);
    expect(parseStoredOfficialPersonName('Иванов Иван Петров').ok).toBe(false);
  });
});
