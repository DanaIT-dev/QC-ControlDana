import {
  ADMIN_BACKFILL_PREVIOUS_ROLE,
  ADMIN_ELIGIBLE_ROLES,
  type AdminEligibleRole,
  type UserRole,
  type UserStatus,
} from '@sgr-registry/contracts';
import { AdminGrantNotEligibleError, LastAdminRevokeError, SelfAdminGrantError } from './errors';

export const ADMIN_GRANT_ELIGIBLE_ROLES = ADMIN_ELIGIBLE_ROLES;
export const ADMIN_GRANT_BACKFILL_ROLE = ADMIN_BACKFILL_PREVIOUS_ROLE;

export type AdminGrantTarget = {
  id: string;
  role: UserRole;
  status: UserStatus;
  archivedAt: Date | string | null;
  roleBeforeAdmin: UserRole | null;
};

export function isAdminEligibleRole(role: UserRole): role is AdminEligibleRole {
  return (ADMIN_ELIGIBLE_ROLES as readonly string[]).includes(role);
}

export function previousRoleAfterAdminRevoke(target: {
  role: UserRole;
  roleBeforeAdmin: UserRole | null;
}): UserRole {
  if (target.role !== 'ADMIN') {
    return target.role;
  }
  if (target.roleBeforeAdmin && isAdminEligibleRole(target.roleBeforeAdmin)) {
    return target.roleBeforeAdmin;
  }
  return ADMIN_BACKFILL_PREVIOUS_ROLE;
}

export function isEligibleAdminGrantTarget(target: AdminGrantTarget): boolean {
  if (target.role === 'ADMIN') {
    return target.status === 'ACTIVE' && !target.archivedAt;
  }
  return target.status === 'ACTIVE' && !target.archivedAt && isAdminEligibleRole(target.role);
}

export function assertCanGrantAdmin(input: { actorId: string; target: AdminGrantTarget }): void {
  if (input.actorId === input.target.id) {
    throw new SelfAdminGrantError();
  }
  if (input.target.role === 'ADMIN') {
    return;
  }
  if (!isEligibleAdminGrantTarget(input.target)) {
    throw new AdminGrantNotEligibleError();
  }
}

export function assertCanRevokeAdmin(input: {
  actorId: string;
  target: AdminGrantTarget;
  activeAdminCount: number;
}): void {
  if (input.actorId === input.target.id) {
    throw new SelfAdminGrantError();
  }
  if (input.target.role !== 'ADMIN') {
    return;
  }
  if (input.activeAdminCount <= 1) {
    throw new LastAdminRevokeError();
  }
}

export function nextAdminGrantState(target: AdminGrantTarget): {
  role: 'ADMIN';
  roleBeforeAdmin: AdminEligibleRole;
} {
  if (target.role === 'ADMIN') {
    const stored = target.roleBeforeAdmin;
    return {
      role: 'ADMIN',
      roleBeforeAdmin:
        stored && isAdminEligibleRole(stored) ? stored : ADMIN_BACKFILL_PREVIOUS_ROLE,
    };
  }
  if (!isEligibleAdminGrantTarget(target) || !isAdminEligibleRole(target.role)) {
    throw new AdminGrantNotEligibleError();
  }
  return { role: 'ADMIN', roleBeforeAdmin: target.role };
}
