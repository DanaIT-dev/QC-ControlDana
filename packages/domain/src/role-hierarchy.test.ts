import { describe, expect, it } from 'vitest';
import { AccountProtectedError } from './errors';
import {
  ROLE_HIERARCHY_LEVELS,
  assignableRolesFor,
  assertCanAssignRole,
  canAssignRole,
  canEditUserProfile,
  canMutateManagedUser,
} from './role-hierarchy';

describe('role hierarchy', () => {
  it('keeps the contracted ranks', () => {
    expect(ROLE_HIERARCHY_LEVELS.SUPER_ADMIN).toBe(100);
    expect(ROLE_HIERARCHY_LEVELS.ADMIN).toBe(80);
    expect(ROLE_HIERARCHY_LEVELS.MANAGER).toBe(60);
    expect(ROLE_HIERARCHY_LEVELS.SGR_MANAGER).toBe(40);
    expect(ROLE_HIERARCHY_LEVELS.RESPONSIBLE_ENGINEER).toBe(20);
    expect(ROLE_HIERARCHY_LEVELS.CONTRACTOR_ENGINEER).toBe(10);
  });

  it('limits role assignment by actor rank', () => {
    expect(assignableRolesFor('SUPER_ADMIN')).toEqual([
      'MANAGER',
      'SGR_MANAGER',
      'RESPONSIBLE_ENGINEER',
      'CONTRACTOR_ENGINEER',
    ]);
    expect(assignableRolesFor('ADMIN')).toEqual([
      'MANAGER',
      'SGR_MANAGER',
      'RESPONSIBLE_ENGINEER',
      'CONTRACTOR_ENGINEER',
    ]);
    expect(assignableRolesFor('MANAGER')).toEqual([
      'SGR_MANAGER',
      'RESPONSIBLE_ENGINEER',
      'CONTRACTOR_ENGINEER',
    ]);
    expect(assignableRolesFor('SGR_MANAGER')).toEqual([]);
    expect(canAssignRole('ADMIN', 'MANAGER')).toBe(true);
    expect(canAssignRole('MANAGER', 'MANAGER')).toBe(false);
    expect(canAssignRole('MANAGER', 'ADMIN')).toBe(false);
    expect(canAssignRole('ADMIN', 'ADMIN')).toBe(false);
    expect(canAssignRole('SUPER_ADMIN', 'ADMIN')).toBe(false);
    expect(canAssignRole('SUPER_ADMIN', 'SUPER_ADMIN')).toBe(false);
    expect(() => assertCanAssignRole('MANAGER', 'ADMIN')).toThrow(AccountProtectedError);
  });

  it('blocks equal or higher profile edits and self-role mutation', () => {
    const admin = { id: 'admin', role: 'ADMIN' as const };
    const otherAdmin = { id: 'admin-2', role: 'ADMIN' as const };
    const manager = { id: 'manager', role: 'MANAGER' as const };
    const otherManager = { id: 'manager-2', role: 'MANAGER' as const };
    const superAdmin = { id: 'sa', role: 'SUPER_ADMIN' as const };
    const engineer = { id: 'eng', role: 'RESPONSIBLE_ENGINEER' as const };
    expect(canEditUserProfile(superAdmin, admin)).toBe(true);
    expect(canEditUserProfile(superAdmin, superAdmin)).toBe(true);
    expect(canEditUserProfile(admin, manager)).toBe(true);
    expect(canEditUserProfile(admin, otherAdmin)).toBe(false);
    expect(canEditUserProfile(admin, superAdmin)).toBe(false);
    expect(canEditUserProfile(manager, engineer)).toBe(true);
    expect(canEditUserProfile(manager, otherManager)).toBe(false);
    expect(canEditUserProfile(manager, admin)).toBe(false);
    expect(canMutateManagedUser(admin, manager)).toBe(true);
    expect(canMutateManagedUser(admin, otherAdmin)).toBe(false);
    expect(canMutateManagedUser(manager, manager)).toBe(false);
    expect(canMutateManagedUser(manager, otherManager)).toBe(false);
    expect(canMutateManagedUser(superAdmin, admin)).toBe(false);
    expect(canMutateManagedUser(superAdmin, manager)).toBe(true);
  });
});
