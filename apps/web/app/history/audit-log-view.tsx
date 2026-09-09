'use client';

import { AUDIT_ACTIONS, AUDIT_ACTION_LABELS } from '@sgr-registry/domain';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { PersonName } from '@/components/person-name';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
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
import { fetchAuditLog } from '@/lib/audit-api';
import { queryKeys } from '@/lib/query-keys';
import { formatTimestamp } from '@/lib/registry-url';

const ENTITY_TYPES = [
  { id: 'ALL', label: 'Все сущности' },
  { id: 'ACT', label: 'Акт' },
  { id: 'DEFECT_ITEM', label: 'Дефект' },
  { id: 'PROPOSAL', label: 'Предложение' },
  { id: 'ATTACHMENT', label: 'Вложение' },
  { id: 'USER', label: 'Пользователь' },
  { id: 'PROPERTY_OBJECT', label: 'Объект' },
  { id: 'ORGANIZATION', label: 'Организация' },
  { id: 'WORK_TYPE', label: 'Вид работ' },
  { id: 'DEFECT_TYPE', label: 'Вид дефекта' },
] as const;

export function AuditLogView() {
  const router = useRouter();
  const params = useSearchParams();
  const search = params.toString();
  const searchParam = params.get('search') ?? '';
  const [searchDraft, setSearchDraft] = useState(searchParam);

  const update = useCallback(
    (next: Record<string, string | null>) => {
      const current = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(next)) {
        if (!value) current.delete(key);
        else current.set(key, value);
      }
      const encoded = current.toString();
      router.replace(`/history${encoded ? `?${encoded}` : ''}`);
    },
    [params, router],
  );

  useEffect(() => {
    setSearchDraft(searchParam);
  }, [searchParam]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const trimmed = searchDraft.trim();
      if (trimmed === searchParam || (trimmed.length === 1 && !searchParam)) {
        return;
      }
      update({ search: trimmed.length >= 2 ? trimmed : null, page: null });
    }, 350);
    return () => window.clearTimeout(handle);
  }, [searchDraft, searchParam, update]);

  const list = useQuery({
    queryKey: queryKeys.auditLog(search),
    queryFn: () => fetchAuditLog(search),
  });

  const page = Number(params.get('page') ?? '1') || 1;
  const totalPages = list.data
    ? Math.max(1, Math.ceil(list.data.totalCount / list.data.pageSize))
    : 1;
  const items = list.data?.items ?? [];

  return (
    <div className="grid min-w-0 gap-4">
      <PageHeader
        title="Журнал аудита"
        description="Полная история изменений. Записи только для чтения."
      />
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row">
        <Input
          aria-label="Поиск по журналу"
          placeholder="Автор, действие, сущность"
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          className="lg:max-w-sm"
        />
        <Select
          value={params.get('action') ?? 'ALL'}
          onValueChange={(value) => update({ action: value === 'ALL' ? null : value, page: null })}
        >
          <SelectTrigger aria-label="Действие" className="lg:w-64">
            <SelectValue placeholder="Все действия" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Все действия</SelectItem>
            {AUDIT_ACTIONS.map((action) => (
              <SelectItem key={action} value={action}>
                {AUDIT_ACTION_LABELS[action] ?? action}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={params.get('entityType') ?? 'ALL'}
          onValueChange={(value) =>
            update({ entityType: value === 'ALL' ? null : value, page: null })
          }
        >
          <SelectTrigger aria-label="Тип сущности" className="lg:w-56">
            <SelectValue placeholder="Все сущности" />
          </SelectTrigger>
          <SelectContent>
            {ENTITY_TYPES.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          aria-label="Дата с"
          value={params.get('from') ?? ''}
          onChange={(event) => update({ from: event.target.value || null, page: null })}
          className="lg:w-44"
        />
        <Input
          type="date"
          aria-label="Дата по"
          value={params.get('to') ?? ''}
          onChange={(event) => update({ to: event.target.value || null, page: null })}
          className="lg:w-44"
        />
      </div>
      {list.isError ? (
        <ErrorState
          description="Не удалось загрузить журнал аудита."
          onRetry={() => void list.refetch()}
        />
      ) : null}
      {list.isLoading ? <TableSkeleton /> : null}
      {!list.isLoading && items.length === 0 ? (
        <EmptyState title="Нет записей" description="По текущим условиям журнал пуст." />
      ) : null}
      <div
        className={
          list.isLoading || items.length === 0
            ? 'hidden'
            : 'hidden min-w-0 overflow-x-auto rounded-md border bg-card md:block'
        }
      >
        <table className="data-table w-full min-w-180 text-sm">
          <thead>
            <tr className="border-b bg-background text-left text-[12px] font-medium text-muted-foreground">
              <th className="px-3 py-3">Время</th>
              <th className="px-3 py-3">Действие</th>
              <th className="px-3 py-3">Автор</th>
              <th className="px-3 py-3">Сущность</th>
              <th className="px-3 py-3">Ссылка</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const href = entityHref(
                item.entityType,
                item.entityId,
                item.parentEntityType,
                item.parentEntityId,
              );
              return (
                <tr key={item.id} className="border-b">
                  <td className="px-3 py-3 whitespace-nowrap text-muted-foreground">
                    {formatTimestamp(item.occurredAt)}
                  </td>
                  <td className="px-3 py-3">{AUDIT_ACTION_LABELS[item.action] ?? item.action}</td>
                  <td className="px-3 py-3">
                    {item.actorName ? <PersonName fullName={item.actorName} /> : '—'}
                  </td>
                  <td className="px-3 py-3">
                    <Badge variant="secondary">{item.entityType}</Badge>
                  </td>
                  <td className="px-3 py-3">
                    {href ? (
                      <Link href={href} className="text-sm font-medium text-brand hover:underline">
                        Открыть
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={list.isLoading || items.length === 0 ? 'hidden' : 'grid gap-3 md:hidden'}>
        {items.map((item) => {
          const href = entityHref(
            item.entityType,
            item.entityId,
            item.parentEntityType,
            item.parentEntityId,
          );
          return (
            <Card key={item.id} className="shadow-none">
              <CardContent className="grid gap-2 p-4">
                <p className="text-sm font-medium">
                  {AUDIT_ACTION_LABELS[item.action] ?? item.action}
                </p>
                <p className="text-sm text-muted-foreground">{formatTimestamp(item.occurredAt)}</p>
                <p className="text-sm">
                  {item.actorName ? <PersonName fullName={item.actorName} /> : '—'}
                </p>
                <Badge variant="secondary" className="w-fit">
                  {item.entityType}
                </Badge>
                {href ? (
                  <Link href={href} className="text-sm font-medium text-brand hover:underline">
                    Открыть связанную запись
                  </Link>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
      {list.data && list.data.totalCount > 0 ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="min-h-11 min-w-11"
            disabled={page <= 1}
            aria-label="Назад"
            onClick={() => update({ page: page > 2 ? String(page - 1) : null })}
          >
            <ChevronLeft />
          </Button>
          <span className="text-sm text-muted-foreground">
            {page} / {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="min-h-11 min-w-11"
            disabled={page >= totalPages}
            aria-label="Вперёд"
            onClick={() => update({ page: String(page + 1) })}
          >
            <ChevronRight />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function entityHref(
  entityType: string,
  entityId: string,
  parentEntityType: string | null,
  parentEntityId: string | null,
): string | null {
  if (entityType === 'ACT') {
    return `/acts/${entityId}`;
  }
  if (entityType === 'DEFECT_ITEM' && parentEntityType === 'ACT' && parentEntityId) {
    return `/acts/${parentEntityId}`;
  }
  if (parentEntityType === 'ACT' && parentEntityId) {
    return `/acts/${parentEntityId}`;
  }
  if (entityType === 'PROPERTY_OBJECT') {
    return '/objects';
  }
  if (entityType === 'USER') {
    return '/users';
  }
  if (entityType === 'ORGANIZATION' || entityType === 'WORK_TYPE' || entityType === 'DEFECT_TYPE') {
    return '/reference-data';
  }
  return null;
}
