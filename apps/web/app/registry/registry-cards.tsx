'use client';

import type { RegistryDefectRow } from '@sgr-registry/contracts';
import { displayedRegistryStatus } from '@sgr-registry/domain';
import { DeadlineBadge, deadlineToneClass, StatusBadge } from '@/components/status-badge';
import { ProposalValue, proposalSlotOf } from '@/components/proposal-value';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatCalendarDate } from '../../lib/registry-url';
import { cn } from '@/lib/utils';

export function RegistryCards({
  rows,
  canViewBC,
  onOpen,
}: {
  rows: RegistryDefectRow[];
  canViewBC: boolean;
  onOpen: (row: RegistryDefectRow) => void;
}) {
  return (
    <ul className="registry-cards grid gap-3">
      {rows.map((row) => (
        <li key={row.rowId}>
          <Card
            className={cn(
              'defect-card gap-0 py-0 shadow-none',
              deadlineToneClass(row.deadlineState),
            )}
          >
            <CardContent className="grid gap-2 p-4">
              <p className="text-[13px] text-muted-foreground">
                {row.formLabel} · {row.actNumber}
              </p>
              <h3 className="text-base font-semibold">{row.objectName}</h3>
              <p className="text-sm">{row.location}</p>
              <p className="text-sm">{row.defectTypeName}</p>
              <StatusBadge
                status={displayedRegistryStatus(row).status}
                label={displayedRegistryStatus(row).label}
              />
              <p className="text-sm">
                Эффективный срок: {formatCalendarDate(row.effectiveDeadline)}
              </p>
              <DeadlineBadge state={row.deadlineState} label={row.deadlineStateLabel} />
              <p className="text-sm text-muted-foreground">
                Инженеры: {row.responsibleEngineers.map((item) => item.fullName).join(', ') || '—'}
              </p>
              <p className="text-sm text-muted-foreground">
                Виновные: {row.liableOrganizations.map((item) => item.name).join(', ') || '—'}
              </p>
              <ProposalBlocks row={row} canViewBC={canViewBC} />
              <Button type="button" className="mt-1 min-h-11" onClick={() => onOpen(row)}>
                Открыть
              </Button>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function ProposalBlocks({ row, canViewBC }: { row: RegistryDefectRow; canViewBC: boolean }) {
  const blocks = [
    { label: 'Предложение А', proposal: row.proposalA },
    ...(canViewBC
      ? [
          { label: 'Предложение B', proposal: proposalSlotOf(row.proposalsBC, 'B') },
          { label: 'Предложение C', proposal: proposalSlotOf(row.proposalsBC, 'C') },
        ]
      : []),
  ].filter((block) => block.proposal);

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className="grid min-w-0 gap-2" data-slot="proposal-blocks">
      {blocks.map((block) => (
        <div key={block.label} className="grid min-w-0 gap-0.5">
          <p className="text-[13px] text-muted-foreground">{block.label}</p>
          <ProposalValue proposal={block.proposal} layout="block" />
        </div>
      ))}
    </div>
  );
}
