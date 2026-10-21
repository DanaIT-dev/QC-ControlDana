import type { ActStatus, DeadlineState, DefectItemStatus } from '@sgr-registry/contracts';
import { AlertCircle, CheckCircle2, Circle, Clock3, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const wrappingBadgeClass =
  'h-auto max-w-full min-w-0 shrink items-start justify-start overflow-visible py-1 whitespace-normal text-left leading-snug';

export function StatusBadge({
  status,
  label,
}: {
  status: DefectItemStatus | ActStatus;
  label: string;
}) {
  const variant =
    status === 'COMPLETED'
      ? 'success'
      : status === 'CANCELLED'
        ? 'error'
        : status === 'NEW' || status === 'IMPORTED_UNSPECIFIED'
          ? 'info'
          : 'warning';
  const Icon =
    status === 'COMPLETED'
      ? CheckCircle2
      : status === 'NEW' || status === 'IMPORTED_UNSPECIFIED'
        ? Sparkles
        : Circle;
  return (
    <Badge variant={variant} className={wrappingBadgeClass}>
      <Icon className="mt-px size-3 shrink-0" aria-hidden />
      <span className="min-w-0">{label}</span>
    </Badge>
  );
}

export function DeadlineBadge({ state, label }: { state: DeadlineState; label: string }) {
  const map: Record<
    DeadlineState,
    { variant: 'success' | 'warning' | 'error' | 'outline' | 'info'; Icon: typeof Circle }
  > = {
    COMPLETED: { variant: 'success', Icon: CheckCircle2 },
    WARNING: { variant: 'warning', Icon: Clock3 },
    OVERDUE: { variant: 'error', Icon: AlertCircle },
    NORMAL: { variant: 'info', Icon: Circle },
    NO_DEADLINE: { variant: 'outline', Icon: Circle },
  };
  const current = map[state];
  return (
    <Badge variant={current.variant} className={wrappingBadgeClass}>
      <current.Icon className="mt-px size-3 shrink-0" aria-hidden />
      <span className="min-w-0">{label}</span>
    </Badge>
  );
}

export function deadlineToneClass(state: DeadlineState): string {
  if (state === 'OVERDUE') {
    return 'border-l-[3px] border-l-error-foreground';
  }
  if (state === 'WARNING') {
    return 'border-l-[3px] border-l-warning-foreground';
  }
  return '';
}

export function TruncateText({ text, className }: { text: string; className?: string }) {
  const display = text || '—';
  return (
    <span className={cn('block max-w-[220px] truncate', className)} title={display}>
      {display}
    </span>
  );
}
