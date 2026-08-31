import type { UserRole } from '@sgr-registry/contracts';
import type { ProposalSlot } from '@sgr-registry/contracts';

export type RegistryAccessMode = 'all_uncancelled' | 'object_assigned';

export function registryAccessMode(role: UserRole): RegistryAccessMode {
  return role === 'RESPONSIBLE_ENGINEER' ? 'object_assigned' : 'all_uncancelled';
}

export function isObjectScopedRole(role: UserRole): boolean {
  return registryAccessMode(role) === 'object_assigned';
}

export function visibleProposalSlots(role: UserRole): ProposalSlot[] {
  if (role === 'RESPONSIBLE_ENGINEER') {
    return ['A'];
  }
  return ['A', 'B', 'C'];
}

export function canViewProposalASum(role: UserRole): boolean {
  return role === 'ADMIN' || role === 'SGR_MANAGER';
}

export function canViewProposalGroupBC(role: UserRole): boolean {
  return visibleProposalSlots(role).includes('B');
}
