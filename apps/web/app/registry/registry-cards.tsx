'use client';

import type { RegistryDefectRow } from '@sgr-registry/contracts';
import {
  MISSING_ENGINEER_LABEL,
  displayObjectName,
  displayedRegistryStatus,
} from '@sgr-registry/domain';
import { DeadlineBadge, deadlineToneClass, StatusBadge } from '@/components/status-badge';
import { ProposalValue, proposalSlotOf } from '@/components/proposal-value';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatCalendarDate } from '../../lib/registry-url';
import { PersonName } from '@/components/person-name';
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
            <CardContent className="grid min-w-0 gap-2 p-4">
              <p className="text-[13px] text-muted-foreground">
                {row.formLabel} · {row.actNumber}
              </p>
              <h3 className="text-base font-semibold">{displayObjectName(row.objectName)}</h3>
              <p className="text-sm">{row.location ?? '—'}</p>
              <p className="text-sm">{row.defectTypeName}</p>
              <StatusBadge
                status={displayedRegistryStatus(row).status}
                label={displayedRegistryStatus(row).label}
              />
              {row.actStatus === 'NEW' && row.fillLabel ? (
                <p className="text-sm">Заполнение: {row.fillLabel}</p>
              ) : null}
              {row.actStatus === 'NEW' && row.assignmentLabel ? (
                <p className="text-sm">Назначение: {row.assignmentLabel}</p>
              ) : null}
              <p className="text-sm">
                Срок устранения:{' '}
                {row.effectiveDeadline
                  ? formatCalendarDate(row.effectiveDeadline)
                  : 'Срок не установлен'}
              </p>
              <DeadlineBadge state={row.deadlineState} label={row.deadlineStateLabel} />
              {row.deadlineNotice && row.deadlineNotice !== row.deadlineStateLabel ? (
                <p className="text-sm whitespace-normal">{row.deadlineNotice}</p>
              ) : null}
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <span className="shrink-0">Инженеры:</span>
                {row.responsibleEngineers.length
                  ? row.responsibleEngineers.map((item, index) => (
                      <PersonName
                        key={`${item.id ?? item.referenceId ?? item.fullName}-${index}`}
                        lastName={item.lastName}
                        firstName={item.firstName}
                        middleName={item.middleName}
                        fullName={item.fullName}
                        unmatched={item.unmatched}
                        sourceNameRaw={item.sourceNameRaw}
                      />
                    ))
                  : MISSING_ENGINEER_LABEL}
              </div>
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
