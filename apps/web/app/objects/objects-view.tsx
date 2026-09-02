'use client';

import type { ObjectsDirectoryResponse } from '@sgr-registry/contracts';
import { OBJECTS_DIRECTORY_PAGE_SIZES } from '@sgr-registry/domain';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCalendarDate } from '../../lib/registry-url';
import { queryKeys } from '../../lib/query-keys';
import { fetchObjectsDirectory } from '../../lib/objects-api';

function emptyDash(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : '—';
}

export function ObjectsView() {
  const router = useRouter();
  const params = useSearchParams();
  const query = useMemo(() => {
    const page = Number.parseInt(params.get('page') ?? '1', 10);
    const pageSize = Number.parseInt(params.get('pageSize') ?? '20', 10);
    return {
      search: params.get('search') ?? '',
      responsibleEngineer: params.get('responsibleEngineer') ?? '',
      page: Number.isInteger(page) && page > 0 ? page : 1,
      pageSize: (OBJECTS_DIRECTORY_PAGE_SIZES as readonly number[]).includes(pageSize)
        ? (pageSize as (typeof OBJECTS_DIRECTORY_PAGE_SIZES)[number])
        : 20,
    };
  }, [params]);
  const [searchDraft, setSearchDraft] = useState(query.search);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    setSearchDraft(query.search);
  }, [query.search]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const current = queryRef.current;
      const trimmed = searchDraft.trim();
      const applied = current.search;
      if (trimmed === applied || (trimmed.length === 1 && !applied)) {
        return;
      }
      navigate({
        ...current,
        page: 1,
        search: trimmed.length >= 2 ? trimmed : '',
      });
    }, 350);
    return () => window.clearTimeout(handle);
  }, [searchDraft]);

  const listQuery = useQuery({
    queryKey: queryKeys.objects.list(query),
    queryFn: () => fetchObjectsDirectory(query),
  });

  function navigate(next: typeof query) {
    const nextParams = new URLSearchParams();
    if (next.search) {
      nextParams.set('search', next.search);
    }
    if (next.responsibleEngineer) {
      nextParams.set('responsibleEngineer', next.responsibleEngineer);
    }
    if (next.page > 1) {
      nextParams.set('page', String(next.page));
    }
    if (next.pageSize !== 20) {
      nextParams.set('pageSize', String(next.pageSize));
    }
    const href = nextParams.size > 0 ? `/objects?${nextParams.toString()}` : '/objects';
    router.replace(href, { scroll: false });
  }

  const data = listQuery.data;
  const rows = data?.items ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = data?.totalPages ?? 0;
  const page = data?.page ?? query.page;
  const pageSize = data?.pageSize ?? query.pageSize;
  const from = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount);

  return (
    <div className="grid min-w-0 gap-4">
      <PageHeader
        title="Объекты"
        description={totalCount > 0 ? `Всего ${totalCount}` : 'Каталог объектов строительства'}
      />
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <label className="grid min-w-0 flex-1 gap-1">
          <span className="text-sm font-medium">Поиск</span>
          <Input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Объект, адрес или ФИО"
            aria-label="Поиск по объектам"
            className="min-h-11"
          />
        </label>
        <label className="grid min-w-0 gap-1 md:w-72">
          <span className="text-sm font-medium">Ответственный инженер</span>
          <Select
            value={query.responsibleEngineer || 'ALL'}
            onValueChange={(value) =>
              navigate({
                ...query,
                page: 1,
                responsibleEngineer: value === 'ALL' ? '' : value,
              })
            }
          >
            <SelectTrigger aria-label="Ответственный инженер" className="min-h-11">
              <SelectValue placeholder="Все" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Все</SelectItem>
              {(data?.responsibleEngineerOptions ?? []).map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      {listQuery.isError ? (
        <ErrorState
          title="Не удалось загрузить объекты"
          description="Повторите попытку."
          onRetry={() => void listQuery.refetch()}
        />
      ) : null}
      {!listQuery.isError && listQuery.isLoading ? <TableSkeleton /> : null}
      {!listQuery.isError && !listQuery.isLoading && rows.length === 0 ? (
        <EmptyState title="Нет объектов" description="По текущим условиям ничего не найдено." />
      ) : null}
      {!listQuery.isError && !listQuery.isLoading && rows.length > 0 ? (
        <>
          <div className="hidden min-w-0 md:block">
            <ObjectsTable data={data!} />
          </div>
          <div className="md:hidden">
            <ObjectsCards data={data!} />
          </div>
        </>
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
              onValueChange={(value) =>
                navigate({ ...query, page: 1, pageSize: Number(value) as 20 | 50 })
              }
            >
              <SelectTrigger aria-label="Строк на странице" className="w-[88px] min-h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OBJECTS_DIRECTORY_PAGE_SIZES.map((size) => (
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
              className="min-h-11 min-w-11"
              disabled={page <= 1}
              aria-label="Назад"
              onClick={() => navigate({ ...query, page: page - 1 })}
            >
              <ChevronLeft />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="min-h-11 min-w-11"
              disabled={page >= totalPages}
              aria-label="Вперёд"
              onClick={() => navigate({ ...query, page: page + 1 })}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ObjectsTable({ data }: { data: ObjectsDirectoryResponse }) {
  return (
    <div className="min-w-0 overflow-x-auto rounded-[10px] border bg-card">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="sticky top-0 z-10 border-b bg-card text-left text-[12px] font-medium text-muted-foreground">
          <tr>
            <th className="px-3 py-3">Объект</th>
            <th className="px-3 py-3">Адрес</th>
            <th className="px-3 py-3 whitespace-nowrap">Дата приёмки в эксплуатацию</th>
            <th className="px-3 py-3 whitespace-nowrap">Дата завершения гарантийного срока</th>
            <th className="px-3 py-3">Ответственный инженер</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((item) => (
            <tr key={item.id} className="border-b align-top">
              <td className="max-w-[22rem] px-3 py-3 font-medium break-words">{item.name}</td>
              <td className="max-w-[16rem] px-3 py-3 break-words text-muted-foreground">
                {emptyDash(item.address)}
              </td>
              <td className="px-3 py-3 whitespace-nowrap">
                {formatCalendarDate(item.commissionedAt)}
              </td>
              <td className="px-3 py-3 whitespace-nowrap">
                {formatCalendarDate(item.warrantyEndsAt)}
              </td>
              <td className="px-3 py-3">
                <ResponsibleCell
                  name={item.sourceResponsibleEngineerName}
                  status={item.responsibleEngineerAccountStatus}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ObjectsCards({ data }: { data: ObjectsDirectoryResponse }) {
  return (
    <ul className="grid gap-3">
      {data.items.map((item) => (
        <li key={item.id}>
          <Card className="shadow-none">
            <CardContent className="grid gap-2 p-4">
              <h2 className="text-base font-semibold break-words">{item.name}</h2>
              <p className="text-sm break-words">{emptyDash(item.address)}</p>
              <p className="text-sm">
                Принят в эксплуатацию: {formatCalendarDate(item.commissionedAt)}
              </p>
              <p className="text-sm">Гарантия до: {formatCalendarDate(item.warrantyEndsAt)}</p>
              <ResponsibleCell
                name={item.sourceResponsibleEngineerName}
                status={item.responsibleEngineerAccountStatus}
              />
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function ResponsibleCell({
  name,
  status,
}: {
  name: string | null;
  status: ObjectsDirectoryResponse['items'][number]['responsibleEngineerAccountStatus'];
}) {
  if (!name) {
    return <span>—</span>;
  }
  return (
    <div className="grid min-w-0 gap-0.5">
      <p className="break-words">Ответственный: {name}</p>
      {status === 'UNRESOLVED' || status === 'AMBIGUOUS' ? (
        <p className="text-[12px] text-muted-foreground">Не связан с учетной записью</p>
      ) : null}
    </div>
  );
}
