import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOCATE_ACT_SEQUENCE_SQL } from '../../src/act-number-sql';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';
import {
  assertOwnedTestPrefix,
  assertSafeTestBucket,
  assertSafeTestEndpoint,
  testRunObjectPrefix,
} from '../../src/test-bucket';

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

describe('test bucket guard', () => {
  it('accepts a dedicated *-test bucket', () => {
    expect(assertSafeTestBucket('sgr-attachments-test')).toBe('sgr-attachments-test');
  });

  it('rejects the development bucket, an empty name, and a production-like name', () => {
    expect(() => assertSafeTestBucket('sgr-attachments')).toThrow(/development or production/);
    expect(() => assertSafeTestBucket('')).toThrow(/empty/);
    expect(() => assertSafeTestBucket('sgr-attachments-production')).toThrow(/production/);
  });

  it('rejects an unknown MinIO endpoint and accepts localhost', () => {
    expect(assertSafeTestEndpoint('http://127.0.0.1:9000')).toContain('127.0.0.1');
    expect(() => assertSafeTestEndpoint('')).toThrow(/empty/);
    expect(() => assertSafeTestEndpoint('https://minio.example.com')).toThrow(/unknown/);
  });

  it('limits deletion to the current run prefix', () => {
    const runId = 'run-11111111-1111-4111-8111-111111111111';
    const prefix = testRunObjectPrefix(runId);
    expect(() => assertOwnedTestPrefix(`${prefix}attachments/abc`, runId)).not.toThrow();
    expect(() => assertOwnedTestPrefix('attachments/abc', runId)).toThrow(/current test run/);
  });
});
