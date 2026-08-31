'use client';

import type { RegistryDefectRow } from '@sgr-registry/contracts';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, FileText } from 'lucide-react';
import { useMemo } from 'react';
import {
  DeadlineBadge,
  deadlineToneClass,
  StatusBadge,
  TruncateText,
} from '@/components/status-badge';
import { ProposalValue, proposalSlotOf } from '@/components/proposal-value';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatCalendarDate, formatTimestamp, isSafeDocumentHref } from '../../lib/registry-url';
import { cn } from '@/lib/utils';

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
      column('formLabel', 'Форма', 'formCode', 'col-required'),
      {
        id: 'actNumber',
        accessorKey: 'actNumber',
        header: headerButton('Номер акта', 'actNumber', sortBy, sortDirection, onSort),
        cell: ({ row }) => (
          <a
            href={`/acts/${row.original.actId}`}
            className="font-medium text-brand hover:underline focus-visible:underline"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpen(row.original);
            }}
          >
            {row.original.actNumber}
          </a>
        ),
        meta: { className: 'col-primary sticky left-0 z-10 bg-card' },
      },
      {
        id: 'status',
        accessorKey: 'defectStatusLabel',
        header: headerButton('Статус', 'status', sortBy, sortDirection, onSort),
        cell: ({ row }) => (
          <StatusBadge status={row.original.defectStatus} label={row.original.defectStatusLabel} />
        ),
        meta: { className: 'col-status' },
      },
      column('objectName', 'Объект', 'objectName', 'col-required'),
      column('objectAddress', 'Адрес', undefined, 'col-secondary hidden xl:table-cell'),
      column('location', 'Помещение', undefined, 'col-required'),
      column('defectTypeName', 'Вид дефекта', 'defectTypeName', 'col-required'),
      column('customerName', 'Заказчик', undefined, 'col-secondary hidden xl:table-cell'),
      {
        id: 'liable',
        header: 'Виновные организации',
        cell: ({ row }) => names(row.original.liableOrganizations.map((item) => item.name)),
        meta: { className: 'col-secondary hidden xl:table-cell' },
      },
      {
        id: 'engineers',
        header: 'Ответственные инженеры',
        cell: ({ row }) => names(row.original.responsibleEngineers.map((item) => item.fullName)),
        meta: { className: 'col-required' },
      },
      dateColumn(
        'plannedDeadline',
        'Срок устранения',
        'plannedDeadline',
        'col-secondary hidden xl:table-cell',
      ),
      dateColumn(
        'claimDeadline',
        'Срок по претензии',
        'claimDeadline',
        'col-secondary hidden xl:table-cell',
      ),
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
        meta: { className: 'col-secondary hidden xl:table-cell' },
      },
      {
        id: 'proposalA',
        header: 'Предложение А',
        cell: ({ row }) => <ProposalValue proposal={row.original.proposalA} />,
        meta: { className: 'col-secondary hidden xl:table-cell min-w-0' },
      },
    ];
    if (canViewBC && expandBC) {
      base.push({
        id: 'proposalB',
        header: 'Предложение B',
        cell: ({ row }) => (
          <ProposalValue proposal={proposalSlotOf(row.original.proposalsBC, 'B')} />
        ),
        meta: { className: 'col-bc min-w-0' },
      });
      base.push({
        id: 'proposalC',
        header: 'Предложение C',
        cell: ({ row }) => (
          <ProposalValue proposal={proposalSlotOf(row.original.proposalsBC, 'C')} />
        ),
        meta: { className: 'col-bc min-w-0' },
      });
    }
    base.push({
      id: 'document',
      header: 'Документ',
      cell: ({ row }) =>
        isSafeDocumentHref(row.original.documentRef) ? (
          <a
            className="inline-flex items-center gap-1 text-brand hover:underline"
            href={row.original.documentRef}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            <FileText className="size-4" aria-hidden />
            Документ
          </a>
        ) : (
          '—'
        ),
      meta: { className: 'col-secondary hidden xl:table-cell' },
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
        cell: ({ getValue }) => <TruncateText text={String(getValue() ?? '—')} />,
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
  }, [canViewBC, expandBC, onOpen, onSort, sortBy, sortDirection]);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.rowId,
    manualPagination: true,
    manualSorting: true,
  });

  return (
    <div className="overflow-hidden rounded-[10px] border bg-card" data-slot="registry-table-wrap">
      {canViewBC ? (
        <div className="flex items-center justify-end border-b px-3 py-2">
          <Button type="button" variant="outline" size="sm" onClick={onToggleBC}>
            {expandBC ? 'Свернуть предложения B и C' : 'Развернуть предложения B и C'}
          </Button>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="registry-table w-full min-w-[760px] border-separate border-spacing-0 text-sm xl:min-w-[1100px]">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    className={cn(
                      'sticky top-0 z-[2] h-11 bg-background px-3 text-left text-[12px] font-medium text-muted-foreground',
                      classNameOf(header.column.columnDef.meta),
                    )}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 8 }).map((_, index) => (
                  <tr key={`skeleton-${index}`} className="h-14">
                    <td colSpan={columns.length} className="px-3">
                      <span className="block h-3.5 animate-pulse rounded bg-muted" />
                    </td>
                  </tr>
                ))
              : table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    className={cn(
                      'registry-row min-h-14 cursor-pointer border-b hover:bg-muted/40 focus-visible:bg-accent',
                      deadlineToneClass(row.original.deadlineState),
                    )}
                    onClick={() => onOpen(row.original)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        onOpen(row.original);
                      }
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className={cn(
                          'border-b px-3 py-2 align-middle',
                          classNameOf(cell.column.columnDef.meta),
                        )}
                      >
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
    <button
      type="button"
      className="inline-flex min-h-11 items-center gap-1 font-medium"
      onClick={() => onSort(field)}
    >
      {title}
      {sortBy === field ? (
        sortDirection === 'asc' ? (
          <ArrowUp className="size-3.5" aria-hidden />
        ) : (
          <ArrowDown className="size-3.5" aria-hidden />
        )
      ) : null}
    </button>
  );
}

function DeadlineCell({ row }: { row: RegistryDefectRow }) {
  return (
    <span className="grid gap-1">
      <span>{formatCalendarDate(row.effectiveDeadline)}</span>
      <DeadlineBadge state={row.deadlineState} label={row.deadlineStateLabel} />
    </span>
  );
}

function names(values: string[]) {
  const text = values.length ? values.join(', ') : '—';
  if (text === '—') {
    return text;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block max-w-[220px] truncate">{text}</span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

function classNameOf(meta: unknown): string | undefined {
  if (meta && typeof meta === 'object' && 'className' in meta) {
    return String((meta as { className?: string }).className ?? '');
  }
  return undefined;
}
