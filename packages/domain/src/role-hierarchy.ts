import type { UserRole } from '@sgr-registry/contracts';
import { OPERATIONAL_ASSIGNABLE_ROLES } from '@sgr-registry/contracts';
import { AccountProtectedError } from './errors';

export const ROLE_HIERARCHY_LEVELS = {
  SUPER_ADMIN: 100,
  ADMIN: 80,
  MANAGER: 60,
  SGR_MANAGER: 40,
  RESPONSIBLE_ENGINEER: 20,
  CONTRACTOR_ENGINEER: 10,
  PENDING_ROLE: 5,
  UNASSIGNED: 0,
} as const satisfies Record<UserRole, number>;

export const PROFILE_EDITOR_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] as const;
export type ProfileEditorRole = (typeof PROFILE_EDITOR_ROLES)[number];

export const OPERATIONS_ADMIN_ROLES = ['ADMIN', 'MANAGER'] as const;
export type OperationsAdminRole = (typeof OPERATIONS_ADMIN_ROLES)[number];

export const BUSINESS_STAFF_ROLES = ['ADMIN', 'MANAGER', 'SGR_MANAGER'] as const;
export type BusinessStaffRole = (typeof BUSINESS_STAFF_ROLES)[number];

export function roleHierarchyLevel(role: UserRole): number {
  return ROLE_HIERARCHY_LEVELS[role];
}

export function isProfileEditorRole(role: UserRole): role is ProfileEditorRole {
  return (PROFILE_EDITOR_ROLES as readonly string[]).includes(role);
}

export function isOperationsAdminRole(role: UserRole): role is OperationsAdminRole {
  return (OPERATIONS_ADMIN_ROLES as readonly string[]).includes(role);
}

export function isBusinessStaffRole(role: UserRole): role is BusinessStaffRole {
  return (BUSINESS_STAFF_ROLES as readonly string[]).includes(role);
}

export function assignableRolesFor(actorRole: UserRole): readonly UserRole[] {
  if (actorRole !== 'SUPER_ADMIN' && !isOperationsAdminRole(actorRole)) {
    return [];
  }
  const actorLevel = roleHierarchyLevel(actorRole);
  return OPERATIONAL_ASSIGNABLE_ROLES.filter((role) => roleHierarchyLevel(role) < actorLevel);
}

export function canAssignRole(actorRole: UserRole, nextRole: UserRole): boolean {
  return assignableRolesFor(actorRole).includes(nextRole);
}

export function canEditUserProfile(
  actor: {
    id: string;
    role: UserRole;
  },
  target: { id: string; role: UserRole },
): boolean {
  if (!isProfileEditorRole(actor.role)) {
    return false;
  }
  if (actor.id === target.id) {
    return true;
  }
  return roleHierarchyLevel(target.role) < roleHierarchyLevel(actor.role);
}

export function canMutateManagedUser(
  actor: {
    id: string;
    role: UserRole;
  },
  target: { id: string; role: UserRole },
): boolean {
  if (!isOperationsAdminRole(actor.role) && actor.role !== 'SUPER_ADMIN') {
    return false;
  }
  if (actor.id === target.id) {
    return false;
  }
  if (target.role === 'SUPER_ADMIN' || target.role === 'ADMIN' || target.role === 'UNASSIGNED') {
    return false;
  }
  return roleHierarchyLevel(target.role) < roleHierarchyLevel(actor.role);
}

export function assertCanEditUserProfile(
  actor: { id: string; role: UserRole },
  target: { id: string; role: UserRole },
): void {
  if (!canEditUserProfile(actor, target)) {
    throw new AccountProtectedError();
  }
}

export function assertCanMutateManagedUser(
  actor: { id: string; role: UserRole },
  target: { id: string; role: UserRole },
): void {
  if (!canMutateManagedUser(actor, target)) {
    throw new AccountProtectedError();
  }
}

export function assertCanAssignRole(actorRole: UserRole, nextRole: UserRole): void {
  if (!canAssignRole(actorRole, nextRole)) {
    throw new AccountProtectedError();
  }
}
