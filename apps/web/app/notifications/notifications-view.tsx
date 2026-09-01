'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { notificationDestination } from '@sgr-registry/domain';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/lib/notifications-api';
import { queryKeys } from '@/lib/query-keys';
import { formatTimestamp } from '@/lib/registry-url';

export function NotificationsView({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const filter = params.get('filter') === 'unread' ? 'unread' : 'all';
  const page = Number(params.get('page') ?? '1') || 1;
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: queryKeys.notifications.list(filter, page),
    queryFn: () => fetchNotifications({ page, filter }),
  });
  const markRead = useMutation({
    mutationFn: (id: string) => markNotificationRead(id, csrfToken),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    },
  });
  const readAll = useMutation({
    mutationFn: () => markAllNotificationsRead(csrfToken),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    },
  });

  function setFilter(next: 'all' | 'unread') {
    const search = new URLSearchParams();
    if (next === 'unread') search.set('filter', 'unread');
    router.replace(`/notifications${search.toString() ? `?${search}` : ''}`);
  }

  async function openItem(item: {
    id: string;
    type: string;
    actId: string | null;
    defectItemId: string | null;
  }) {
    try {
      await markRead.mutateAsync(item.id);
    } catch {
      /* destination handles missing access */
    }
    const href = notificationDestination(item);
    if (href) {
      router.push(href);
    }
  }

  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <div>
      <PageHeader
        title="Уведомления"
        description="Внутренние сообщения по срокам, назначениям и файлам."
        actions={
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => readAll.mutate()}
            disabled={readAll.isPending}
          >
            Прочитать все
          </Button>
        }
      />
      <div className="mb-4 flex gap-2">
        <Button
          type="button"
          variant={filter === 'all' ? 'default' : 'outline'}
          className="min-h-11"
          onClick={() => setFilter('all')}
        >
          Все
        </Button>
        <Button
          type="button"
          variant={filter === 'unread' ? 'default' : 'outline'}
          className="min-h-11"
          onClick={() => setFilter('unread')}
        >
          Непрочитанные
        </Button>
      </div>
      {list.isLoading ? <TableSkeleton /> : null}
      {list.isError ? (
        <ErrorState
          description="Не удалось загрузить уведомления"
          onRetry={() => void list.refetch()}
        />
      ) : null}
      {list.data && list.data.items.length === 0 ? (
        <EmptyState title="Нет уведомлений" description="Новые события появятся здесь." />
      ) : null}
      {list.data && list.data.items.length > 0 ? (
        <ul className="grid gap-3">
          {list.data.items.map((item) => (
            <li key={item.id}>
              <Card className="shadow-none">
                <CardContent className="grid gap-2 p-4">
                  <p className="text-xs text-muted-foreground">{item.type}</p>
                  <h2 className="text-base font-semibold">
                    {item.readAt ? item.title : `Непрочитано: ${item.title}`}
                  </h2>
                  <p className="text-sm">{item.body}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatTimestamp(item.occurredAt)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" className="min-h-11" onClick={() => void openItem(item)}>
                      Открыть
                    </Button>
                    {!item.readAt ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        onClick={() => markRead.mutate(item.id)}
                      >
                        Отметить прочитанным
                      </Button>
                    ) : (
                      <p className="self-center text-xs text-muted-foreground">Прочитано</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
      {list.data && totalPages > 1 ? (
        <div className="mt-4 flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={page <= 1}
            onClick={() =>
              router.replace(
                `/notifications?${new URLSearchParams({
                  ...(filter === 'unread' ? { filter } : {}),
                  page: String(page - 1),
                }).toString()}`,
              )
            }
          >
            Назад
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={page >= totalPages}
            onClick={() =>
              router.replace(
                `/notifications?${new URLSearchParams({
                  ...(filter === 'unread' ? { filter } : {}),
                  page: String(page + 1),
                }).toString()}`,
              )
            }
          >
            Вперёд
          </Button>
        </div>
      ) : null}
    </div>
  );
}
