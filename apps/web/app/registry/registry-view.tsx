'use client';

import { useQuery } from '@tanstack/react-query';
import {
  DEFAULT_REGISTRY_SORT,
  parseRegistryListQuery,
  REGISTRY_PAGE_SIZES,
  type RegistryListQuery,
} from '@sgr-registry/domain';
import type { RegistryDefectRow, SafeUserProfile } from '@sgr-registry/contracts';
import { canViewProposalASum, canViewProposalGroupBC } from '@sgr-registry/domain';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchRegistryFilterOptions,
  fetchRegistryList,
  fetchRegistrySummary,
} from '../../lib/registry-api';
import { queryFromSearchParams, searchParamsFromQuery } from '../../lib/registry-url';
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
  const [mobileFilters, setMobileFilters] = useState(false);
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
      const search = searchParamsFromQuery({
        ...current,
        page: 1,
        search: trimmed.length >= 2 ? trimmed : null,
      });
      router.replace(search ? `/registry?${search}` : '/registry', { scroll: false });
    }, 350);
    return () => window.clearTimeout(handle);
  }, [searchDraft, router]);

  const listQuery = useQuery({
    queryKey: ['registry', 'defects', query],
    queryFn: () => fetchRegistryList(query),
  });
  const summaryQuery = useQuery({
    queryKey: ['registry', 'summary', query],
    queryFn: () => fetchRegistrySummary(query),
  });
  const optionsQuery = useQuery({
    queryKey: ['registry', 'filter-options'],
    queryFn: fetchRegistryFilterOptions,
  });

  function replaceQuery(next: RegistryListQuery) {
    const search = searchParamsFromQuery(next);
    router.replace(search ? `/registry?${search}` : '/registry', { scroll: false });
  }

  function openRow(row: RegistryDefectRow) {
    const preserved = searchParamsFromQuery(query);
    const extra = new URLSearchParams(preserved);
    extra.set('defect', row.defectItemId);
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
  const from = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount);

  return (
    <div className="registry-page">
      <div className="registry-toolbar">
        <button
          type="button"
          className="ghost-button filters-open"
          onClick={() => setMobileFilters(true)}
        >
          Фильтры
        </button>
      </div>
      <RegistrySummary
        summary={summaryQuery.data}
        query={query}
        canViewSum={canViewProposalASum(user.role)}
        onChange={replaceQuery}
      />
      <RegistryFilters
        query={query}
        options={optionsQuery.data ?? null}
        searchDraft={searchDraft}
        onSearchDraft={setSearchDraft}
        onSearchSubmit={() => {
          const trimmed = searchDraft.trim();
          replaceQuery({ ...query, page: 1, search: trimmed.length >= 2 ? trimmed : null });
        }}
        onChange={replaceQuery}
        onReset={() => replaceQuery(parseRegistryListQuery({}))}
        mobileOpen={mobileFilters}
        onCloseMobile={() => setMobileFilters(false)}
      />
      {listQuery.isError ? (
        <section className="panel">
          <p className="form-error">Не удалось загрузить реестр.</p>
          <button type="button" className="primary-button" onClick={() => void listQuery.refetch()}>
            Повторить
          </button>
        </section>
      ) : null}
      {!listQuery.isError && !listQuery.isLoading && rows.length === 0 ? (
        <section className="panel empty-state">
          <h2>Нет строк</h2>
          <p className="lead">По текущим условиям нет доступных дефектов.</p>
        </section>
      ) : null}
      {!isMobile ? (
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
          loading={listQuery.isLoading}
        />
      ) : (
        <RegistryCards rows={rows} onOpen={openRow} />
      )}
      <div className="pagination">
        <p>
          {from}–{to} из {totalCount}
        </p>
        <label>
          Строк на странице
          <select
            value={pageSize}
            onChange={(event) =>
              replaceQuery({
                ...query,
                page: 1,
                pageSize: Number(event.target.value) as (typeof REGISTRY_PAGE_SIZES)[number],
              })
            }
          >
            {REGISTRY_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <div className="pagination-buttons">
          <button
            type="button"
            className="ghost-button"
            disabled={page <= 1}
            onClick={() => replaceQuery({ ...query, page: page - 1 })}
          >
            Назад
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={page >= (listQuery.data?.totalPages || 1)}
            onClick={() => replaceQuery({ ...query, page: page + 1 })}
          >
            Вперёд
          </button>
        </div>
      </div>
    </div>
  );
}
