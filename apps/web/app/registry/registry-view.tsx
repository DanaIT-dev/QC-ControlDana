'use client';

import { useQuery } from '@tanstack/react-query';
import {
  DEFAULT_REGISTRY_SORT,
  parseRegistryListQuery,
  REGISTRY_PAGE_SIZES,
  type RegistryListQuery,
} from '@sgr-registry/domain';
import type { RegistryDefectRow, SafeUserProfile } from '@sgr-registry/contracts';
import { canCreateAct, canViewProposalASum, canViewProposalGroupBC } from '@sgr-registry/domain';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  fetchRegistryFilterOptions,
  fetchRegistryList,
  fetchRegistrySummary,
} from '../../lib/registry-api';
import {
  queryFromSearchParams,
  registryNavigation,
  searchParamsFromQuery,
} from '../../lib/registry-url';
import { queryKeys } from '../../lib/query-keys';
import { readPageSizePreference, writePageSizePreference } from '../../lib/page-size-preference';
import { RegistryCards } from './registry-cards';
import { RegistryFilters } from './registry-filters';
import { RegistrySummary } from './registry-summary';
import { readExpandBC, RegistryTable, writeExpandBC } from './registry-table';

export function RegistryView({ user }: { user: SafeUserProfile }) {
  const router = useRouter();
  const params = useSearchParams();
  const query = useMemo(() => {
    try {
      return queryFromSearchParams(new URLSearchParams(params.toString()));
    } catch {
      return parseRegistryListQuery({});
    }
  }, [params]);
  const [searchDraft, setSearchDraft] = useState(query.search ?? '');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expandBC, setExpandBC] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    setSearchDraft(query.search ?? '');
  }, [query.search]);

  useEffect(() => {
    setExpandBC(readExpandBC());
    const media = window.matchMedia('(max-width: 767px)');
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const current = queryRef.current;
      const trimmed = searchDraft.trim();
      const applied = current.search ?? '';
      if (trimmed === applied || (trimmed.length === 1 && !applied)) {
        return;
      }
      const navigation = registryNavigation({
        current,
        next: {
          ...current,
          page: 1,
          search: trimmed.length >= 2 ? trimmed : null,
        },
        mode: 'replace',
      });
      if (!navigation) {
        return;
      }
      router.replace(navigation.href, { scroll: false });
    }, 350);
    return () => window.clearTimeout(handle);
  }, [searchDraft, router]);

  const listQuery = useQuery({
    queryKey: queryKeys.registry.defects(query),
    queryFn: () => fetchRegistryList(query),
  });
  const summaryQuery = useQuery({
    queryKey: queryKeys.registry.summary(query),
    queryFn: () => fetchRegistrySummary(query),
  });
  const optionsQuery = useQuery({
    queryKey: queryKeys.registry.filterOptions,
    queryFn: fetchRegistryFilterOptions,
  });

  function navigateQuery(next: RegistryListQuery, mode: 'push' | 'replace') {
    const navigation = registryNavigation({ current: query, next, mode });
    if (!navigation) {
      return;
    }
    if (navigation.method === 'push') {
      router.push(navigation.href, { scroll: false });
      return;
    }
    router.replace(navigation.href, { scroll: false });
  }

  function pushQuery(next: RegistryListQuery) {
    navigateQuery(next, 'push');
  }

  function replaceQuery(next: RegistryListQuery) {
    navigateQuery(next, 'replace');
  }

  useEffect(() => {
    if (params.has('pageSize')) {
      return;
    }
    const stored = readPageSizePreference('sgr.registry.pageSize', REGISTRY_PAGE_SIZES, 50);
    if (stored === query.pageSize) {
      return;
    }
    replaceQuery({
      ...query,
      page: 1,
      pageSize: stored as (typeof REGISTRY_PAGE_SIZES)[number],
    });
  }, [params, query.pageSize]);

  function openRow(row: RegistryDefectRow) {
    const preserved = searchParamsFromQuery(query);
    const extra = new URLSearchParams(preserved);
    if (row.defectItemId) {
      extra.set('defect', row.defectItemId);
    }
    router.push(`/acts/${row.actId}?${extra.toString()}`);
  }

  function onSort(field: string) {
    const nextDirection =
      query.sortBy === field && query.sortDirection === 'asc'
        ? 'desc'
        : query.sortBy === field
          ? 'asc'
          : DEFAULT_REGISTRY_SORT.sortDirection;
    replaceQuery({
      ...query,
      page: 1,
      sortBy: field as RegistryListQuery['sortBy'],
      sortDirection: nextDirection,
    });
  }

  const rows = listQuery.data?.items ?? [];
  const totalCount = listQuery.data?.totalCount ?? 0;
  const page = listQuery.data?.page ?? query.page;
  const pageSize = listQuery.data?.pageSize ?? query.pageSize;
  const totalPages = listQuery.data?.totalPages || 1;
  const from = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount);

  return (
    <div className="registry-page grid gap-4">
      <PageHeader
        title="Реестр дефектных актов"
        description={
          listQuery.isSuccess
            ? `Всего: ${totalCount} · актов: ${listQuery.data.actCount}`
            : 'Контроль сроков, статусов и назначений по дефектным актам СГР.'
        }
        actions={
          canCreateAct(user.role) ? (
            <Button asChild>
              <Link href="/acts/new">
                <Plus data-icon="inline-start" />
                Создать акт
              </Link>
            </Button>
          ) : null
        }
      />
      <RegistrySummary
        summary={summaryQuery.data}
        query={query}
        canViewSum={canViewProposalASum(user.role)}
        onChange={pushQuery}
        loading={summaryQuery.isLoading}
      />
      {(summaryQuery.data?.unfinishedDrafts.length ?? 0) > 0 ? (
        <section className="rounded-md border bg-card px-4 py-3" aria-label="Незаполненные акты">
          <h2 className="text-sm font-medium">Незаполненные акты</h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {summaryQuery.data?.unfinishedDrafts.map((draft) => (
              <li key={draft.id}>
                <Link
                  className="text-sm text-primary underline-offset-2 hover:underline"
                  href={`/acts/${draft.id}`}
                >
                  {draft.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <RegistryFilters
        query={query}
        options={optionsQuery.data ?? null}
        searchDraft={searchDraft}
        onSearchDraft={setSearchDraft}
        onSearchSubmit={() => {
          const trimmed = searchDraft.trim();
          pushQuery({ ...query, page: 1, search: trimmed.length >= 2 ? trimmed : null });
        }}
        onChange={pushQuery}
        onReset={() => {
          setSearchDraft('');
          pushQuery(parseRegistryListQuery({}));
        }}
        sheetOpen={filtersOpen}
        onSheetOpenChange={setFiltersOpen}
        resultCount={listQuery.isSuccess ? totalCount : undefined}
      />
      {listQuery.isError ? (
        <ErrorState
          description="Не удалось загрузить реестр."
          onRetry={() => void listQuery.refetch()}
        />
      ) : null}
      {!listQuery.isError && listQuery.isLoading ? <TableSkeleton /> : null}
      {!listQuery.isError && !listQuery.isLoading && rows.length === 0 ? (
        <EmptyState title="Нет строк" description="По текущим условиям нет доступных дефектов." />
      ) : null}
      {!listQuery.isError && !listQuery.isLoading && rows.length > 0 ? (
        isMobile ? (
          <RegistryCards
            rows={rows}
            canViewBC={canViewProposalGroupBC(user.role)}
            onOpen={openRow}
          />
        ) : (
          <RegistryTable
            rows={rows}
            canViewBC={canViewProposalGroupBC(user.role)}
            expandBC={expandBC}
            onToggleBC={() => {
              const next = !expandBC;
              writeExpandBC(next);
              setExpandBC(next);
            }}
            onOpen={openRow}
            sortBy={query.sortBy}
            sortDirection={query.sortDirection}
            onSort={onSort}
            loading={false}
          />
        )
      ) : null}
      <div className="flex flex-col gap-3 rounded-[10px] border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {from}–{to} из {totalCount}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            Строк на странице
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                const pageSize = Number(value) as (typeof REGISTRY_PAGE_SIZES)[number];
                writePageSizePreference('sgr.registry.pageSize', pageSize);
                replaceQuery({
                  ...query,
                  page: 1,
                  pageSize,
                });
              }}
            >
              <SelectTrigger aria-label="Строк на странице" className="w-[88px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REGISTRY_PAGE_SIZES.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={page <= 1}
              aria-label="Назад"
              onClick={() => replaceQuery({ ...query, page: page - 1 })}
            >
              <ChevronLeft />
            </Button>
            <div className="hidden items-center gap-1 md:flex">
              {visiblePages(page, totalPages).map((item) =>
                item === '…' ? (
                  <span key={`e-${item}`} className="px-1 text-muted-foreground">
                    …
                  </span>
                ) : (
                  <Button
                    key={item}
                    type="button"
                    variant={item === page ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    aria-current={item === page ? 'page' : undefined}
                    onClick={() => replaceQuery({ ...query, page: item })}
                  >
                    {item}
                  </Button>
                ),
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={page >= totalPages}
              aria-label="Вперёд"
              onClick={() => replaceQuery({ ...query, page: page + 1 })}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function visiblePages(page: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  const items = new Set(
    [1, totalPages, page, page - 1, page + 1].filter((value) => value >= 1 && value <= totalPages),
  );
  const sorted = [...items].sort((a, b) => a - b);
  const result: Array<number | '…'> = [];
  for (const [index, value] of sorted.entries()) {
    if (index > 0 && value - (sorted[index - 1] ?? 0) > 1) {
      result.push('…');
    }
    result.push(value);
  }
  return result;
}
