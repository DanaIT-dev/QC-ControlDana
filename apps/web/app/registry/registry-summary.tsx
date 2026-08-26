'use client';

import type { RegistrySummaryResponse } from '@sgr-registry/contracts';
import type { RegistryListQuery } from '@sgr-registry/domain';

export function RegistrySummary({
  summary,
  query,
  canViewSum,
  onChange,
}: {
  summary: RegistrySummaryResponse | undefined;
  query: RegistryListQuery;
  canViewSum: boolean;
  onChange: (next: RegistryListQuery) => void;
}) {
  const items = [
    {
      key: 'total',
      label: 'Всего',
      value: summary?.total,
      active: query.statuses.length === 0 && query.deadlineState.length === 0,
      apply: () => onChange({ ...query, page: 1, statuses: [], deadlineState: [] }),
    },
    {
      key: 'inProgress',
      label: 'В работе',
      value: summary?.inProgress,
      active: query.statuses.length === 1 && query.statuses[0] === 'IN_PROGRESS',
      apply: () => onChange({ ...query, page: 1, statuses: ['IN_PROGRESS'], deadlineState: [] }),
    },
    {
      key: 'completed',
      label: 'Исполнено',
      value: summary?.completed,
      active: query.statuses.length === 1 && query.statuses[0] === 'COMPLETED',
      apply: () => onChange({ ...query, page: 1, statuses: ['COMPLETED'], deadlineState: [] }),
    },
    {
      key: 'warning',
      label: 'Приближается срок',
      value: summary?.warning,
      active: query.deadlineState.length === 1 && query.deadlineState[0] === 'WARNING',
      apply: () => onChange({ ...query, page: 1, deadlineState: ['WARNING'], statuses: [] }),
    },
    {
      key: 'overdue',
      label: 'Просрочено',
      value: summary?.overdue,
      active: query.deadlineState.length === 1 && query.deadlineState[0] === 'OVERDUE',
      apply: () => onChange({ ...query, page: 1, deadlineState: ['OVERDUE'], statuses: [] }),
    },
  ];

  return (
    <section className="summary-grid" aria-label="Сводка реестра">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={item.active ? 'summary-card summary-card--active' : 'summary-card'}
          aria-pressed={item.active}
          onClick={item.apply}
        >
          <span className="summary-card__label">{item.label}</span>
          <span className="summary-card__value">{item.value ?? '—'}</span>
        </button>
      ))}
      {canViewSum ? (
        <div className="summary-card summary-card--sum">
          <span className="summary-card__label">Сумма предложений А</span>
          <span className="summary-card__value">
            {summary?.proposalASum ?? '—'} {summary?.currency ?? 'BYN'}
          </span>
        </div>
      ) : null}
    </section>
  );
}
