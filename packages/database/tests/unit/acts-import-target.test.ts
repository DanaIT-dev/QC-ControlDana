import { describe, expect, it } from 'vitest';
import {
  assertActsImportDatabaseTarget,
  ActsImportTargetError,
} from '../../src/acts-import-target';

describe('acts import target', () => {
  it('allows development sgr_registry dry-run and confirmed apply', () => {
    expect(
      assertActsImportDatabaseTarget({
        nodeEnv: 'development',
        databaseUrl: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry',
        apply: false,
      }).databaseName,
    ).toBe('sgr_registry');
    expect(
      assertActsImportDatabaseTarget({
        nodeEnv: 'development',
        databaseUrl: 'postgresql://sgr_migrator:x@localhost:5432/sgr_registry',
        apply: true,
        confirmDatabase: 'sgr_registry',
        confirmEnv: 'sgr_registry',
      }).databaseName,
    ).toBe('sgr_registry');
  });

  it('refuses production and non-loopback hosts', () => {
    expect(() =>
      assertActsImportDatabaseTarget({
        nodeEnv: 'production',
        databaseUrl: 'postgresql://sgr_migrator:x@127.0.0.1:5432/sgr_registry',
        apply: true,
        confirmDatabase: 'sgr_registry',
        confirmProduction: true,
      }),
    ).toThrow(ActsImportTargetError);
    expect(() =>
      assertActsImportDatabaseTarget({
        nodeEnv: 'development',
        databaseUrl: 'postgresql://sgr_migrator:x@db.internal:5432/sgr_registry',
        apply: false,
      }),
    ).toThrow(/localhost/);
  });
});
