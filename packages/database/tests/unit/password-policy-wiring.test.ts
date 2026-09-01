import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPasswordPolicy } from '@sgr-registry/domain';

describe('password policy wiring', () => {
  it('uses the shared policy and hidden TTY input in SUPER_ADMIN provisioning', () => {
    const source = readFileSync(
      resolve(__dirname, '../../scripts/provision-super-admin.ts'),
      'utf8',
    );
    expect(source).toMatch(/assertPasswordPolicy\(password, \{ email, fullName \}\)/);
    expect(source).toMatch(/promptHidden\('Password: '/);
    expect(source).toMatch(/if \(!stdin\.isTTY\)/);
    expect(source).toMatch(
      /Password must be entered from a masked interactive prompt, not arguments or env/,
    );
    expect(source).toMatch(/provisionSuperAdmin\(/);
    expect(source).toMatch(/Replacement confirmation must be entered from an interactive terminal/);
    const library = readFileSync(resolve(__dirname, '../../src/super-admin-provision.ts'), 'utf8');
    expect(library).toMatch(/assertPasswordPolicy\(input\.password, \{ email, fullName \}\)/);
    expect(library).toMatch(/argon2\.hash\(input\.password, \{ type: argon2\.argon2id \}\)/);
    expect(library).toMatch(/\$transaction/);
    expect(library).toMatch(/pg_advisory_xact_lock/);
    expect(library.indexOf('assertPasswordPolicy')).toBeLessThan(library.indexOf('$transaction'));
  });

  it('uses the shared policy in test SUPER_ADMIN fixtures and development seed', () => {
    const fixture = readFileSync(resolve(__dirname, '../../src/test-super-admin.ts'), 'utf8');
    const seed = readFileSync(resolve(__dirname, '../../prisma/seed.ts'), 'utf8');
    expect(fixture).toMatch(/assertPasswordPolicy\(options\.password, \{ email, fullName \}\)/);
    expect(fixture).toMatch(/assertE2eDatabaseTarget/);
    expect(seed).toMatch(/assertPasswordPolicy\(demoPassword/);
  });

  it('accepts the simplified SUPER_ADMIN provisioning format', () => {
    expect(() =>
      assertPasswordPolicy('treefrog', {
        email: 'bolutenko_p@bir.by',
        fullName: 'Суперадминистратор',
      }),
    ).not.toThrow();
  });
});
