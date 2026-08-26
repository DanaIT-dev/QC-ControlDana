import type { UserRole } from '@sgr-registry/contracts';
import type { ProposalSlot } from '@sgr-registry/contracts';

export type RegistryAccessMode = 'all_uncancelled' | 'assigned_only';

export function registryAccessMode(role: UserRole): RegistryAccessMode {
  return role === 'RESPONSIBLE_ENGINEER' ? 'assigned_only' : 'all_uncancelled';
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
