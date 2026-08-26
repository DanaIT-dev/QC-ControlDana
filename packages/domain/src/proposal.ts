import type { ProposalSlot } from '@sgr-registry/contracts';
import { DuplicateProposalSlotError } from './errors';

export interface ProposalRef {
  defectItemId: string;
  slot: ProposalSlot;
}

export function assertUniqueProposalSlots(proposals: readonly ProposalRef[]): void {
  const used = new Map<string, Set<ProposalSlot>>();

  for (const proposal of proposals) {
    const slots = used.get(proposal.defectItemId) ?? new Set<ProposalSlot>();
    if (slots.has(proposal.slot)) {
      throw new DuplicateProposalSlotError(proposal.slot);
    }
    slots.add(proposal.slot);
    used.set(proposal.defectItemId, slots);
  }
}

export function canAddProposalSlot(existing: readonly ProposalRef[], next: ProposalRef): boolean {
  return !existing.some(
    (proposal) => proposal.defectItemId === next.defectItemId && proposal.slot === next.slot,
  );
}
