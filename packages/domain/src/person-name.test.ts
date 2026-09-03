import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors';
import {
  composeOfficialFullName,
  parsePersonNameForForm,
  parsePersonNameInput,
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
        parsePersonNameInput({ lastName: 'Петрова-Смирнова', firstName: 'Анна', middleName: '' }),
      ),
    ).toBe('Петрова-Смирнова Анна');
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
