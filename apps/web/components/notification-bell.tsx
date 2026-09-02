'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { notificationDestination } from '@sgr-registry/domain';
import {
  fetchNotifications,
  fetchUnreadCount,
  markNotificationRead,
} from '@/lib/notifications-api';
import { queryKeys } from '@/lib/query-keys';
import { formatTimestamp } from '@/lib/registry-url';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function NotificationBell({
  csrfToken,
  canMutate = true,
}: {
  csrfToken: string;
  canMutate?: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const unread = useQuery({
    queryKey: queryKeys.notifications.unread,
    queryFn: fetchUnreadCount,
    refetchInterval: 45_000,
    refetchOnWindowFocus: true,
  });
  const recent = useQuery({
    queryKey: queryKeys.notifications.preview,
    queryFn: () => fetchNotifications({ page: 1, filter: 'all' }),
    refetchInterval: 45_000,
    refetchOnWindowFocus: true,
  });
  const markRead = useMutation({
    mutationFn: (id: string) => markNotificationRead(id, csrfToken),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    },
  });
  const badge = unread.data?.badge ?? '0';
  const count = unread.data?.count ?? 0;
  const items = recent.data?.items.slice(0, 8) ?? [];

  async function openItem(item: {
    id: string;
    type: string;
    actId: string | null;
    defectItemId: string | null;
  }) {
    if (canMutate) {
      try {
        await markRead.mutateAsync(item.id);
      } catch {
        /* 404 is handled by the destination */
      }
    }
    const href = notificationDestination(item);
    router.push(href ?? '/notifications');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative min-h-11 min-w-11"
          aria-label={count > 0 ? `Уведомления, непрочитанных ${badge}` : 'Уведомления'}
        >
          <BellIcon className="size-5" aria-hidden />
          {count > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-error px-1 text-[10px] font-semibold text-error-foreground">
              {badge}
              <span className="sr-only">непрочитанных</span>
            </span>
          ) : (
            <span className="sr-only">нет непрочитанных</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(100vw-2rem,22rem)] p-0">
        <DropdownMenuLabel className="px-3 py-2">Уведомления</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {recent.isLoading ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">Загрузка…</p>
        ) : null}
        {recent.isError ? (
          <p className="px-3 py-4 text-sm text-error-foreground">
            Не удалось загрузить уведомления
          </p>
        ) : null}
        {!recent.isLoading && !recent.isError && items.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">Нет уведомлений</p>
        ) : null}
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            className="min-h-11 cursor-pointer items-start whitespace-normal py-2"
            onSelect={() => void openItem(item)}
          >
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">
                {item.readAt ? item.title : `● ${item.title}`}
              </span>
              <span className="text-xs text-muted-foreground">{item.body}</span>
              <span className="text-xs text-muted-foreground">
                {formatTimestamp(item.occurredAt)}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="min-h-11">
          <Link href="/notifications">Все уведомления</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
