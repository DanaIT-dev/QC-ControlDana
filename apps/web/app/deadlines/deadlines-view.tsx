'use client';

import { useQuery } from '@tanstack/react-query';
import { displaySlaLabel } from '@sgr-registry/domain';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import {
  EmptyState,
  ErrorState,
  MetricSkeleton,
  TableSkeleton,
  CardListSkeleton,
} from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fetchSlaItems, fetchSlaSummary } from '@/lib/notifications-api';
import { queryKeys } from '@/lib/query-keys';
import { formatCalendarDate } from '@/lib/registry-url';

function deadlineKindLabel(kind: string): string {
  if (kind === 'GENERAL') return 'Общий срок';
  if (kind === 'THIRD_PARTY') return 'Срок третьей стороны';
  return kind;
}

const BUCKETS = [
  { id: 'WARNING', label: 'Приближается срок', key: 'warning' as const },
  { id: 'DUE_TODAY', label: 'Срок сегодня', key: 'dueToday' as const },
  { id: 'OVERDUE_1_2', label: 'Просрочено 1–2 дня', key: 'overdue1to2' as const },
  { id: 'OVERDUE_3_6', label: 'Просрочено 3–6 дней', key: 'overdue3to6' as const },
  { id: 'OVERDUE_7_PLUS', label: 'Просрочено 7+ дней', key: 'overdue7plus' as const },
  { id: 'NO_DEADLINE', label: 'Срок не установлен', key: 'noDeadline' as const },
];

export function DeadlinesView() {
  const router = useRouter();
  const params = useSearchParams();
  const search = params.toString();
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  const summary = useQuery({ queryKey: queryKeys.sla.summary, queryFn: fetchSlaSummary });
  const items = useQuery({
    queryKey: queryKeys.sla.items(search),
    queryFn: () => fetchSlaItems(search ? `?${search}` : ''),
  });

  function update(next: Record<string, string | null>) {
    const current = new URLSearchParams(search);
    for (const [key, value] of Object.entries(next)) {
      if (!value) current.delete(key);
      else current.set(key, value);
    }
    current.delete('page');
    const encoded = current.toString();
    router.replace(`/deadlines${encoded ? `?${encoded}` : ''}`);
  }

  const page = Number(params.get('page') ?? '1') || 1;
  const totalPages = items.data
    ? Math.max(1, Math.ceil(items.data.total / items.data.pageSize))
    : 1;

  return (
    <div>
      <PageHeader
        title="Контроль сроков"
        description="Контроль установленных сроков. Отсчёт и уведомления включаются после взятия акта в работу."
      />
      {summary.isLoading ? <MetricSkeleton /> : null}
      {summary.data ? (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
          {BUCKETS.map((bucket) => (
            <button
              key={bucket.id}
              type="button"
              className="min-h-11 rounded-[10px] border bg-card p-3 text-left"
              onClick={() =>
                update({ bucket: params.get('bucket') === bucket.id ? null : bucket.id })
              }
            >
              <p className="text-xs text-muted-foreground">{bucket.label}</p>
              <p className="text-xl font-semibold">{summary.data[bucket.key]}</p>
            </button>
          ))}
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap gap-2">
        <Select
          value={params.get('kind') ?? 'all'}
          onValueChange={(value) => update({ kind: value === 'all' ? null : value })}
        >
          <SelectTrigger className="min-h-11 w-44" aria-label="Вид срока">
            <SelectValue placeholder="Вид срока" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все виды</SelectItem>
            <SelectItem value="GENERAL">Общий срок</SelectItem>
            <SelectItem value="THIRD_PARTY">Срок третьей стороны</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {items.isLoading ? isMobile ? <CardListSkeleton /> : <TableSkeleton /> : null}
      {items.isError ? (
        <ErrorState
          description="Не удалось загрузить контроль сроков"
          onRetry={() => void items.refetch()}
        />
      ) : null}
      {items.data && items.data.items.length === 0 ? (
        <EmptyState
          title="Нет строк"
          description="В доступном контуре нет записей с выбранным фильтром."
        />
      ) : null}
      {items.data && items.data.items.length > 0 && isMobile ? (
        <ul className="grid gap-3">
          {items.data.items.map((row) => (
            <li key={`${row.defectItemId}-${row.kind}`}>
              <Card className="shadow-none">
                <CardContent className="grid gap-2 p-4">
                  <p className="text-xs text-muted-foreground">
                    {row.formCode} · {row.officialNumber}
                  </p>
                  <h2 className="text-base font-semibold">{row.objectName}</h2>
                  <p className="text-sm">{row.location}</p>
                  <p className="text-sm">{row.defectTypeName}</p>
                  <p className="text-sm">Ответственные: {row.responsibleNames.join(', ') || '—'}</p>
                  <Badge variant="outline">{deadlineKindLabel(row.kind)}</Badge>
                  <p className="text-sm">
                    Срок: {formatCalendarDate(row.deadline?.slice(0, 10) ?? null)}
                  </p>
                  <p className="text-sm">Дней: {row.daysOffset ?? '—'}</p>
                  <p className="text-sm">{displaySlaLabel(row.state)}</p>
                  <Button asChild className="min-h-11">
                    <Link href={`/acts/${row.actId}?defect=${row.defectItemId}`}>Открыть</Link>
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
      {items.data && items.data.items.length > 0 && !isMobile ? (
        <div className="overflow-x-auto rounded-[10px] border">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3">Акт</th>
                <th className="p-3">Объект</th>
                <th className="p-3">Помещение</th>
                <th className="p-3">Вид дефекта</th>
                <th className="p-3">Ответственные</th>
                <th className="p-3">Вид срока</th>
                <th className="p-3">Срок</th>
                <th className="p-3">Дней</th>
                <th className="p-3">Эскалация</th>
                <th className="p-3">Статус</th>
              </tr>
            </thead>
            <tbody>
              {items.data.items.map((row) => (
                <tr key={`${row.defectItemId}-${row.kind}`} className="border-b">
                  <td className="p-3">
                    <Link
                      className="underline"
                      href={`/acts/${row.actId}?defect=${row.defectItemId}`}
                    >
                      {row.formCode} {row.officialNumber}
                    </Link>
                  </td>
                  <td className="p-3">{row.objectName}</td>
                  <td className="p-3">{row.location}</td>
                  <td className="p-3">{row.defectTypeName}</td>
                  <td className="p-3">{row.responsibleNames.join(', ') || '—'}</td>
                  <td className="p-3">{deadlineKindLabel(row.kind)}</td>
                  <td className="p-3">{formatCalendarDate(row.deadline?.slice(0, 10) ?? null)}</td>
                  <td className="p-3">{row.daysOffset ?? '—'}</td>
                  <td className="p-3">{row.escalationLevel ?? '—'}</td>
                  <td className="p-3">{displaySlaLabel(row.state)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {items.data && totalPages > 1 ? (
        <div className="mt-4 flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={page <= 1}
            onClick={() => {
              const current = new URLSearchParams(search);
              current.set('page', String(page - 1));
              router.replace(`/deadlines?${current.toString()}`);
            }}
          >
            Назад
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={page >= totalPages}
            onClick={() => {
              const current = new URLSearchParams(search);
              current.set('page', String(page + 1));
              router.replace(`/deadlines?${current.toString()}`);
            }}
          >
            Вперёд
          </Button>
        </div>
      ) : null}
    </div>
  );
}
