import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOCATE_ACT_SEQUENCE_SQL } from '../../src/act-number-sql';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';

describe('act number SQL', () => {
  it('uses an atomic sequence table instead of COUNT(*) + 1', () => {
    expect(ALLOCATE_ACT_SEQUENCE_SQL).toContain('act_number_sequences');
    expect(ALLOCATE_ACT_SEQUENCE_SQL).toContain('ON CONFLICT');
    expect(ALLOCATE_ACT_SEQUENCE_SQL.toLowerCase()).not.toContain('count(');
    expect(ALLOCATE_ACT_SEQUENCE_SQL).not.toMatch(/count\s*\+\s*1/i);

    const source = readFileSync(resolve(__dirname, '../../src/act-number.ts'), 'utf8');
    const sqlSource = readFileSync(resolve(__dirname, '../../src/act-number-sql.ts'), 'utf8');
    expect(sqlSource).not.toMatch(/count\s*\+\s*1/i);
    expect(source).not.toMatch(/count\s*\+\s*1/i);
    expect(source).not.toMatch(/\.count\(/);
  });
});

describe('test database guard', () => {
  it('accepts a dedicated *_test database', () => {
    const parsed = assertSafeTestDatabaseUrl(
      'postgresql://sgr_registry:password@localhost:5432/sgr_registry_test',
    );
    expect(parsed.pathname).toBe('/sgr_registry_test');
  });

  it('rejects the development database name', () => {
    expect(() =>
      assertSafeTestDatabaseUrl('postgresql://sgr_registry:password@localhost:5432/sgr_registry'),
    ).toThrow(/must end with "_test"/);
  });
});
