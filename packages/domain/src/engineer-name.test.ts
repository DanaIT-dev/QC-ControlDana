import { describe, expect, it } from 'vitest';
import {
  accountMatchesSource,
  classifyEngineerMatch,
  foldEngineerKey,
  formatAccountAsInitials,
} from './engineer-name';
import { responsibleEngineerNotice } from './objects-directory';

const engineer = (fullName: string, extras?: { role?: string; status?: string; id?: string }) => ({
  id: extras?.id,
  fullName,
  role: extras?.role ?? 'RESPONSIBLE_ENGINEER',
  status: extras?.status ?? 'ACTIVE',
});

describe('engineer name matching', () => {
  it('normalizes NFKC, edges, repeated spaces, case and yo/ye', () => {
    expect(foldEngineerKey('  Василёвич\u00A0\u00A0М.В.  ')).toBe('василевич м.в.');
    expect(foldEngineerKey('ВАСИЛЕВИЧ м.в.')).toBe('василевич м.в.');
    expect(foldEngineerKey('Ёлкин Е.Ё.')).toBe('елкин е.е.');
  });

  it('formats approved account FIO as surname and initials', () => {
    expect(formatAccountAsInitials('Василевич Михаил Викторович')).toBe('Василевич М.В.');
    expect(formatAccountAsInitials('Богданович Иван Александрович')).toBe('Богданович И.А.');
  });

  it('matches full account FIO to abbreviated Excel source', () => {
    expect(accountMatchesSource('Василевич Михаил Викторович', 'Василевич М.В.')).toBe(true);
    expect(accountMatchesSource('Единственный Эдуард Эдуардович', 'Единственный Э.Э.')).toBe(true);
    expect(accountMatchesSource('Богданович Иван Александрович', 'Богданович И.А.')).toBe(true);
    expect(accountMatchesSource('Василевич Михаил Викторович', 'Василевич М. В.')).toBe(true);
    expect(accountMatchesSource('Василевич Михаил Викторович', 'Василевич М.В')).toBe(true);
    expect(accountMatchesSource('Василёвич Михаил Викторович', 'Василевич М.В.')).toBe(true);
  });

  it('rejects a wrong surname, wrong initials, or incomplete names', () => {
    expect(accountMatchesSource('Богданович Иван Александрович', 'Василевич М.В.')).toBe(false);
    expect(accountMatchesSource('Василевич Максим Викторович', 'Василевич М.В.')).toBe(true);
    expect(accountMatchesSource('Василевич Михаил Александрович', 'Василевич М.В.')).toBe(false);
    expect(accountMatchesSource('Василевич Михаил', 'Василевич М.В.')).toBe(false);
    expect(accountMatchesSource('Василевич', 'Василевич М.В.')).toBe(false);
    expect(accountMatchesSource('Михаил Викторович Василевич', 'Василевич М.В.')).toBe(false);
  });

  it('does not match by surname alone', () => {
    expect(accountMatchesSource('Василевич Иван Александрович', 'Василевич М.В.')).toBe(false);
  });

  it('classifies unique, unmatched, invalid and ambiguous results', () => {
    expect(classifyEngineerMatch(null, []).result).toBe('EMPTY');
    expect(
      classifyEngineerMatch('Василевич М.В.', [
        engineer('Василевич Михаил Викторович', { id: 'a' }),
      ]).result,
    ).toBe('MATCHED');
    expect(
      classifyEngineerMatch('Василевич М.В.', [engineer('Богданович Иван Александрович')]).result,
    ).toBe('UNMATCHED');
    expect(classifyEngineerMatch('???', [engineer('Василевич Михаил Викторович')]).result).toBe(
      'INVALID',
    );
    expect(
      classifyEngineerMatch('Василевич М.В.', [
        engineer('Василевич Михаил Викторович', { id: 'a' }),
        engineer('Василевич Максим Владимирович', { id: 'b' }),
      ]).result,
    ).toBe('AMBIGUOUS');
  });

  it('ignores users without RESPONSIBLE_ENGINEER or an active status', () => {
    expect(
      classifyEngineerMatch('Василевич М.В.', [
        engineer('Василевич Михаил Викторович', { role: 'CONTRACTOR_ENGINEER' }),
        engineer('Василевич Михаил Викторович', { status: 'ARCHIVED' }),
        engineer('Василевич Михаил Викторович', { role: 'ADMIN' }),
      ]).result,
    ).toBe('UNMATCHED');
  });

  it('maps linked and unlinked directory states to user-facing notices', () => {
    expect(
      responsibleEngineerNotice({
        id: '1',
        fullName: 'Василевич Михаил Викторович',
        status: 'ACTIVE',
        linked: true,
        accessActive: true,
      }),
    ).toBeNull();
    expect(
      responsibleEngineerNotice({
        id: '1',
        fullName: 'Василевич Михаил Викторович',
        status: 'ARCHIVED',
        linked: true,
        accessActive: false,
      }),
    ).toBe('Учетная запись неактивна');
    expect(
      responsibleEngineerNotice({
        fullName: 'Василевич М.В.',
        linked: false,
        linkState: 'UNMATCHED',
      }),
    ).toBe('Не связан с учетной записью');
    expect(
      responsibleEngineerNotice({
        fullName: 'Василевич М.В.',
        linked: false,
        linkState: 'AMBIGUOUS',
      }),
    ).toBe('Требуется подтверждение администратора');
  });
});
