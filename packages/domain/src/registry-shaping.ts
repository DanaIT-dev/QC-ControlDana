import type { ProposalSlot, UserRole } from '@sgr-registry/contracts';
import {
  canViewProposalASum,
  canViewProposalGroupBC,
  visibleProposalSlots,
} from './registry-access';
import { serializeDecimal } from './deadline';

export interface ProposalSource {
  slot: ProposalSlot;
  amount: { toFixed(digits: number): string } | string;
  currency: string;
  contractorName: string;
  organizationId?: string;
  version?: number;
  status?: 'ACTIVE' | 'ARCHIVED';
}

export interface ShapedProposal {
  slot: ProposalSlot;
  amount: string;
  currency: string;
  contractorName: string;
  organizationId?: string;
  version?: number;
  status?: 'ACTIVE' | 'ARCHIVED';
}

export interface ShapedProposals {
  proposalA: ShapedProposal | null;
  proposalsBC?: ShapedProposal[];
}

function toDto(proposal: ProposalSource): ShapedProposal {
  return {
    slot: proposal.slot,
    amount: serializeDecimal(proposal.amount),
    currency: proposal.currency,
    contractorName: proposal.contractorName,
    ...(proposal.organizationId ? { organizationId: proposal.organizationId } : {}),
    ...(proposal.version !== undefined ? { version: proposal.version } : {}),
    ...(proposal.status ? { status: proposal.status } : {}),
  };
}

export function shapeProposals(proposals: ProposalSource[], role: UserRole): ShapedProposals {
  const allowed = new Set(visibleProposalSlots(role));
  const visible = proposals.filter((proposal) => allowed.has(proposal.slot)).map(toDto);
  const proposalA = visible.find((proposal) => proposal.slot === 'A') ?? null;
  if (!canViewProposalGroupBC(role)) {
    return { proposalA };
  }
  return {
    proposalA,
    proposalsBC: visible.filter((proposal) => proposal.slot === 'B' || proposal.slot === 'C'),
  };
}

export function shapeSummary<T extends Record<string, unknown>>(
  base: T,
  role: UserRole,
  proposalASum: { toFixed(digits: number): string } | string | null,
): T & { proposalASum?: string } {
  if (!canViewProposalASum(role)) {
    const { proposalASum: _omitted, ...rest } = base as T & { proposalASum?: string };
    void _omitted;
    return rest as T;
  }
  return {
    ...base,
    proposalASum: serializeDecimal(proposalASum ?? '0.00'),
  };
}
