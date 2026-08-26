'use client';

import type { RegistryDefectRow } from '@sgr-registry/contracts';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useMemo } from 'react';
import { formatCalendarDate, formatTimestamp, isSafeDocumentHref } from '../../lib/registry-url';

const BC_STORAGE_KEY = 'sgr.ui.expandProposalBC';

export function readExpandBC(): boolean {
  if (typeof sessionStorage === 'undefined') {
    return false;
  }
  return sessionStorage.getItem(BC_STORAGE_KEY) === '1';
}

export function writeExpandBC(value: boolean): void {
  sessionStorage.setItem(BC_STORAGE_KEY, value ? '1' : '0');
}

export function RegistryTable({
  rows,
  canViewBC,
  expandBC,
  onToggleBC,
  onOpen,
  sortBy,
  sortDirection,
  onSort,
  loading,
}: {
  rows: RegistryDefectRow[];
  canViewBC: boolean;
  expandBC: boolean;
  onToggleBC: () => void;
  onOpen: (row: RegistryDefectRow) => void;
  sortBy: string;
  sortDirection: string;
  onSort: (field: string) => void;
  loading: boolean;
}) {
  const columns = useMemo<ColumnDef<RegistryDefectRow>[]>(() => {
    const base: ColumnDef<RegistryDefectRow>[] = [
      column('formLabel', 'Форма', 'formCode'),
      column('actNumber', 'Номер акта', 'actNumber', 'col-primary'),
      {
        id: 'status',
        accessorKey: 'defectStatusLabel',
        header: headerButton('Статус', 'status', sortBy, sortDirection, onSort),
        cell: ({ row }) => <StatusBadge row={row.original} />,
        meta: { className: 'col-status' },
      },
      column('objectName', 'Объект', 'objectName', 'col-required'),
      column('objectAddress', 'Адрес', undefined, 'col-secondary'),
      column('location', 'Помещение', undefined, 'col-required'),
      column('defectTypeName', 'Вид дефекта', 'defectTypeName', 'col-required'),
      column('customerName', 'Заказчик', undefined, 'col-secondary'),
      {
        id: 'liable',
        header: 'Виновные организации',
        cell: ({ row }) => names(row.original.liableOrganizations.map((item) => item.name)),
        meta: { className: 'col-secondary' },
      },
      {
        id: 'engineers',
        header: 'Ответственные инженеры',
        cell: ({ row }) => names(row.original.responsibleEngineers.map((item) => item.fullName)),
        meta: { className: 'col-required' },
      },
      dateColumn('plannedDeadline', 'Срок устранения', 'plannedDeadline', 'col-secondary'),
      dateColumn('claimDeadline', 'Срок по претензии', 'claimDeadline', 'col-secondary'),
      {
        id: 'effectiveDeadline',
        header: headerButton(
          'Эффективный срок',
          'effectiveDeadline',
          sortBy,
          sortDirection,
          onSort,
        ),
        cell: ({ row }) => <DeadlineCell row={row.original} />,
        meta: { className: 'col-required col-deadline' },
      },
      {
        id: 'readyAt',
        header: headerButton('Дата готовности', 'readyAt', sortBy, sortDirection, onSort),
        cell: ({ row }) => (
          <span title={row.original.readyAt ?? undefined}>
            {formatTimestamp(row.original.readyAt)}
          </span>
        ),
        meta: { className: 'col-secondary' },
      },
      {
        id: 'proposalA',
        header: 'Предложение А',
        cell: ({ row }) => amount(row.original.proposalA),
        meta: { className: 'col-secondary' },
      },
    ];
    if (canViewBC && expandBC) {
      base.push({
        id: 'proposalB',
        header: 'Предложение B',
        cell: ({ row }) => amount(slot(row.original, 'B')),
        meta: { className: 'col-bc' },
      });
      base.push({
        id: 'proposalC',
        header: 'Предложение C',
        cell: ({ row }) => amount(slot(row.original, 'C')),
        meta: { className: 'col-bc' },
      });
    }
    base.push({
      id: 'document',
      header: 'Документ',
      cell: ({ row }) =>
        isSafeDocumentHref(row.original.documentRef) ? (
          <a
            className="text-link"
            href={row.original.documentRef}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            Документ
          </a>
        ) : (
          '—'
        ),
      meta: { className: 'col-secondary' },
    });
    return base;

    function column(
      accessorKey: keyof RegistryDefectRow,
      title: string,
      sortField?: string,
      className?: string,
    ): ColumnDef<RegistryDefectRow> {
      return {
        id: String(accessorKey),
        accessorKey,
        header: sortField ? headerButton(title, sortField, sortBy, sortDirection, onSort) : title,
        cell: ({ getValue }) => <Truncate text={String(getValue() ?? '—')} />,
        meta: { className },
      };
    }

    function dateColumn(
      accessorKey: keyof RegistryDefectRow,
      title: string,
      sortField: string,
      className?: string,
    ): ColumnDef<RegistryDefectRow> {
      return {
        id: String(accessorKey),
        accessorKey,
        header: headerButton(title, sortField, sortBy, sortDirection, onSort),
        cell: ({ getValue }) => formatCalendarDate((getValue() as string | null) ?? null),
        meta: { className },
      };
    }
  }, [canViewBC, expandBC, onSort, sortBy, sortDirection]);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.rowId,
    manualPagination: true,
    manualSorting: true,
  });

  return (
    <div className="registry-table-wrap">
      {canViewBC ? (
        <div className="bc-toggle">
          <button type="button" className="ghost-button" onClick={onToggleBC}>
            {expandBC ? 'Свернуть предложения B и C' : 'Развернуть предложения B и C'}
          </button>
        </div>
      ) : null}
      <div className="table-scroll">
        <table className="registry-table">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th key={header.id} className={classNameOf(header.column.columnDef.meta)}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 8 }).map((_, index) => (
                  <tr key={`skeleton-${index}`} className="skeleton-row">
                    <td colSpan={columns.length}>
                      <span className="skeleton-bar" />
                    </td>
                  </tr>
                ))
              : table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    className={`registry-row registry-row--${row.original.deadlineState.toLowerCase()}`}
                    onClick={() => onOpen(row.original)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        onOpen(row.original);
                      }
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className={classNameOf(cell.column.columnDef.meta)}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function headerButton(
  title: string,
  field: string,
  sortBy: string,
  sortDirection: string,
  onSort: (field: string) => void,
) {
  return () => (
    <button type="button" className="sort-button" onClick={() => onSort(field)}>
      {title}
      {sortBy === field ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  );
}

function StatusBadge({ row }: { row: RegistryDefectRow }) {
  const kind = row.defectStatus === 'COMPLETED' ? 'ok' : 'progress';
  return <span className={`status-pill status-pill--${kind}`}>{row.defectStatusLabel}</span>;
}

function DeadlineCell({ row }: { row: RegistryDefectRow }) {
  return (
    <span className={`deadline-cell deadline-cell--${row.deadlineState.toLowerCase()}`}>
      <span>{formatCalendarDate(row.effectiveDeadline)}</span>
      {row.deadlineState === 'WARNING' ||
      row.deadlineState === 'OVERDUE' ||
      row.deadlineState === 'NO_DEADLINE' ? (
        <span className="deadline-label">{row.deadlineStateLabel}</span>
      ) : null}
    </span>
  );
}

function Truncate({ text }: { text: string }) {
  return (
    <span className="truncate" title={text}>
      {text}
    </span>
  );
}

function names(values: string[]) {
  const text = values.length ? values.join(', ') : '—';
  return <Truncate text={text} />;
}

function slot(row: RegistryDefectRow, code: 'B' | 'C') {
  return row.proposalsBC?.find((item) => item.slot === code) ?? null;
}

function amount(value: RegistryDefectRow['proposalA']) {
  if (!value) {
    return '—';
  }
  return `${value.amount} ${value.currency}`;
}

function classNameOf(meta: unknown): string | undefined {
  if (meta && typeof meta === 'object' && 'className' in meta) {
    return String((meta as { className?: string }).className ?? '');
  }
  return undefined;
}
