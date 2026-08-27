'use client';

import type { RegistryDefectRow } from '@sgr-registry/contracts';
import { DeadlineBadge, deadlineToneClass, StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatCalendarDate } from '../../lib/registry-url';
import { cn } from '@/lib/utils';

export function RegistryCards({
  rows,
  onOpen,
}: {
  rows: RegistryDefectRow[];
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
              <StatusBadge status={row.defectStatus} label={row.defectStatusLabel} />
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
