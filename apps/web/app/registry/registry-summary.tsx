'use client';

import type { RegistrySummaryResponse } from '@sgr-registry/contracts';
import type { RegistryListQuery } from '@sgr-registry/domain';
import { AlertTriangle, Banknote, CheckCircle2, Clock3, FolderOpen, ListTodo } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function RegistrySummary({
  summary,
  query,
  canViewSum,
  onChange,
  loading,
}: {
  summary: RegistrySummaryResponse | undefined;
  query: RegistryListQuery;
  canViewSum: boolean;
  onChange: (next: RegistryListQuery) => void;
  loading?: boolean;
}) {
  const items: Array<{
    key: string;
    label: string;
    value: string | number | undefined;
    active: boolean;
    apply?: () => void;
    icon: LucideIcon;
    tone: 'neutral' | 'info' | 'success' | 'warning' | 'error';
  }> = [
    {
      key: 'total',
      label: 'Всего',
      value: summary?.total,
      active: query.statuses.length === 0 && query.deadlineState.length === 0,
      apply: () => onChange({ ...query, page: 1, statuses: [], deadlineState: [] }),
      icon: FolderOpen,
      tone: 'neutral',
    },
    {
      key: 'inProgress',
      label: 'В работе',
      value: summary?.inProgress,
      active: query.statuses.length === 1 && query.statuses[0] === 'IN_PROGRESS',
      apply: () => onChange({ ...query, page: 1, statuses: ['IN_PROGRESS'], deadlineState: [] }),
      icon: ListTodo,
      tone: 'info',
    },
    {
      key: 'completed',
      label: 'Исполнено',
      value: summary?.completed,
      active: query.statuses.length === 1 && query.statuses[0] === 'COMPLETED',
      apply: () => onChange({ ...query, page: 1, statuses: ['COMPLETED'], deadlineState: [] }),
      icon: CheckCircle2,
      tone: 'success',
    },
    {
      key: 'warning',
      label: 'Приближается срок',
      value: summary?.warning,
      active: query.deadlineState.length === 1 && query.deadlineState[0] === 'WARNING',
      apply: () => onChange({ ...query, page: 1, deadlineState: ['WARNING'], statuses: [] }),
      icon: Clock3,
      tone: 'warning',
    },
    {
      key: 'overdue',
      label: 'Просрочено',
      value: summary?.overdue,
      active: query.deadlineState.length === 1 && query.deadlineState[0] === 'OVERDUE',
      apply: () => onChange({ ...query, page: 1, deadlineState: ['OVERDUE'], statuses: [] }),
      icon: AlertTriangle,
      tone: 'error',
    },
  ];

  return (
    <section
      className={cn('grid grid-cols-2 gap-3', canViewSum ? 'lg:grid-cols-6' : 'lg:grid-cols-5')}
      aria-label="Сводка реестра"
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-pressed={item.active}
          onClick={item.apply}
          className={cn(
            'flex min-h-[88px] flex-col justify-between rounded-[10px] border bg-card p-3 text-left shadow-none transition-colors hover:bg-muted/40',
            item.active && 'border-brand bg-accent/60',
            toneBar(item.tone),
          )}
        >
          <span className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-muted-foreground">{item.label}</span>
            <item.icon className={cn('size-4', toneIcon(item.tone))} aria-hidden />
          </span>
          <span className="text-[22px] font-semibold leading-none">
            {loading && item.value === undefined ? '—' : (item.value ?? '—')}
          </span>
        </button>
      ))}
      {canViewSum ? (
        <div className="col-span-2 flex min-h-[88px] flex-col justify-between rounded-[10px] border bg-card p-3 lg:col-span-1">
          <span className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-muted-foreground">
              Сумма предложений А
            </span>
            <Banknote className="size-4 text-brand" aria-hidden />
          </span>
          <span className="text-[18px] font-semibold leading-tight sm:text-[22px]">
            {summary?.proposalASum ?? '—'} {summary?.currency ?? 'BYN'}
          </span>
        </div>
      ) : null}
    </section>
  );
}

function toneBar(tone: 'neutral' | 'info' | 'success' | 'warning' | 'error'): string {
  if (tone === 'success') return 'border-t-2 border-t-success-foreground';
  if (tone === 'warning') return 'border-t-2 border-t-warning-foreground';
  if (tone === 'error') return 'border-t-2 border-t-error-foreground';
  if (tone === 'info') return 'border-t-2 border-t-brand';
  return 'border-t-2 border-t-border';
}

function toneIcon(tone: 'neutral' | 'info' | 'success' | 'warning' | 'error'): string {
  if (tone === 'success') return 'text-success-foreground';
  if (tone === 'warning') return 'text-warning-foreground';
  if (tone === 'error') return 'text-error-foreground';
  if (tone === 'info') return 'text-brand';
  return 'text-muted-foreground';
}
