'use client';

import type { RegistryProposalDto } from '@sgr-registry/contracts';
import { formatProposalMoney } from '@sgr-registry/domain';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type ProposalDisplay = Pick<RegistryProposalDto, 'contractorName' | 'amount' | 'currency'> | null;

export function ProposalValue({
  proposal,
  layout = 'compact',
}: {
  proposal: ProposalDisplay | undefined;
  layout?: 'compact' | 'block';
}) {
  if (!proposal) {
    return (
      <span className="text-muted-foreground" data-slot="proposal-value-empty">
        —
      </span>
    );
  }

  const money = formatProposalMoney(proposal.amount, proposal.currency);
  const nameClass = cn('font-medium', layout === 'compact' ? 'block truncate' : 'break-words');

  return (
    <span
      className={cn('grid min-w-0 gap-0.5', layout === 'compact' && 'max-w-[14rem]')}
      data-slot="proposal-value"
    >
      {layout === 'compact' ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={nameClass}>{proposal.contractorName}</span>
          </TooltipTrigger>
          <TooltipContent>{proposal.contractorName}</TooltipContent>
        </Tooltip>
      ) : (
        <span className={nameClass}>{proposal.contractorName}</span>
      )}
      <span className="text-[13px] tabular-nums text-foreground/75">{money}</span>
    </span>
  );
}

export function proposalSlotOf(
  proposals: RegistryProposalDto[] | undefined,
  slot: 'B' | 'C',
): RegistryProposalDto | null {
  return proposals?.find((item) => item.slot === slot) ?? null;
}
