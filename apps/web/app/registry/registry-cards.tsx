'use client';

import type { RegistryDefectRow } from '@sgr-registry/contracts';
import { formatCalendarDate } from '../../lib/registry-url';

export function RegistryCards({
  rows,
  onOpen,
}: {
  rows: RegistryDefectRow[];
  onOpen: (row: RegistryDefectRow) => void;
}) {
  return (
    <ul className="registry-cards">
      {rows.map((row) => (
        <li key={row.rowId}>
          <article className={`defect-card defect-card--${row.deadlineState.toLowerCase()}`}>
            <p className="defect-card__kicker">
              {row.formLabel} · {row.actNumber}
            </p>
            <h3>{row.objectName}</h3>
            <p>{row.location}</p>
            <p>{row.defectTypeName}</p>
            <p>
              <span
                className={`status-pill status-pill--${row.defectStatus === 'COMPLETED' ? 'ok' : 'progress'}`}
              >
                {row.defectStatusLabel}
              </span>
            </p>
            <p>
              Эффективный срок: {formatCalendarDate(row.effectiveDeadline)}
              {row.deadlineStateLabel ? ` · ${row.deadlineStateLabel}` : ''}
            </p>
            <p>
              Инженеры: {row.responsibleEngineers.map((item) => item.fullName).join(', ') || '—'}
            </p>
            <p>Виновные: {row.liableOrganizations.map((item) => item.name).join(', ') || '—'}</p>
            <button type="button" className="primary-button" onClick={() => onOpen(row)}>
              Открыть
            </button>
          </article>
        </li>
      ))}
    </ul>
  );
}
