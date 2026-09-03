import type { UserRole } from '@sgr-registry/contracts';
import type { ProposalSlot } from '@sgr-registry/contracts';
import { isOversightRole } from './capabilities';
import { isBusinessStaffRole } from './role-hierarchy';

export type RegistryAccessMode = 'all' | 'all_uncancelled' | 'object_assigned';

export function registryAccessMode(role: UserRole): RegistryAccessMode {
  if (isOversightRole(role)) {
    return 'all';
  }
  return role === 'RESPONSIBLE_ENGINEER' ? 'object_assigned' : 'all_uncancelled';
}

export function isObjectScopedRole(role: UserRole): boolean {
  return registryAccessMode(role) === 'object_assigned';
}

export function visibleProposalSlots(role: UserRole): ProposalSlot[] {
  if (role === 'RESPONSIBLE_ENGINEER') {
    return ['A'];
  }
  if (isBusinessStaffRole(role) || role === 'CONTRACTOR_ENGINEER' || isOversightRole(role)) {
    return ['A', 'B', 'C'];
  }
  return [];
}

export function canViewProposalASum(role: UserRole): boolean {
  return isBusinessStaffRole(role) || isOversightRole(role);
}

export function canViewProposalGroupBC(role: UserRole): boolean {
  return visibleProposalSlots(role).includes('B');
}
