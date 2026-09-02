'use client';

import type { SuperAdminDirectoryUser } from '@sgr-registry/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { UserAvatar } from '@/components/user-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError, commandFetch } from '../../lib/command-api';

export function SuperAdminView({ csrfToken }: { csrfToken: string }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    type: 'grant' | 'revoke';
    user: SuperAdminDirectoryUser;
  } | null>(null);
  const [lastAdminWarning, setLastAdminWarning] = useState(false);

  const adminsQuery = useQuery({
    queryKey: ['super-admin', 'admins'],
    queryFn: async () => {
      const response = await fetch('/api/super-admin/admins', { credentials: 'include' });
      if (!response.ok) {
        throw new Error('admins');
      }
      return (await response.json()) as { items: SuperAdminDirectoryUser[] };
    },
  });
  const eligibleQuery = useQuery({
    queryKey: ['super-admin', 'eligible', search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search.trim().length >= 2) {
        params.set('search', search.trim());
      }
      const response = await fetch(`/api/super-admin/eligible-users?${params.toString()}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('eligible');
      }
      return (await response.json()) as { items: SuperAdminDirectoryUser[] };
    },
  });

  const admins = adminsQuery.data?.items ?? [];
  const eligible = eligibleQuery.data?.items ?? [];
  const lastAdmin = admins.length <= 1;

  async function submit(type: 'grant' | 'revoke', user: SuperAdminDirectoryUser) {
    if (pendingId) {
      return;
    }
    setPendingId(user.id);
    try {
      if (type === 'grant') {
        await commandFetch(`/api/super-admin/admins/${user.id}`, {
          method: 'POST',
          csrfToken,
          body: { expectedVersion: user.version },
        });
        toast.success('Права администратора назначены');
      } else {
        await commandFetch(`/api/super-admin/admins/${user.id}`, {
          method: 'DELETE',
          csrfToken,
          body: { expectedVersion: user.version },
        });
        toast.success('Права администратора сняты');
      }
      setConfirm(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['super-admin', 'admins'] }),
        queryClient.invalidateQueries({ queryKey: ['super-admin', 'eligible'] }),
      ]);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'LAST_ADMIN_PROTECTED') {
        setLastAdminWarning(true);
        toast.error(error.message);
        return;
      }
      toast.error(error instanceof ApiError ? error.message : 'Ошибка');
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="grid gap-6">
      <PageHeader
        title="Администраторы"
        description="Назначение и снятие прав обычного администратора."
      />
      <div className="grid gap-3">
        <h2 className="text-lg font-semibold">Текущие администраторы</h2>
        {adminsQuery.isError ? (
          <ErrorState
            description="Не удалось загрузить администраторов."
            onRetry={() => void adminsQuery.refetch()}
          />
        ) : null}
        {adminsQuery.isLoading ? <TableSkeleton /> : null}
        {!adminsQuery.isLoading && admins.length === 0 ? (
          <EmptyState
            title="Нет администраторов"
            description="Назначьте сотрудника из списка ниже."
          />
        ) : null}
        <ul className="grid gap-2">
          {admins.map((user) => (
            <li key={user.id}>
              <Card className="shadow-none">
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                  <UserAvatar name={user.fullName} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{user.fullName}</p>
                    <p className="truncate text-sm text-muted-foreground">{user.email}</p>
                    <Badge variant="secondary" className="mt-1">
                      {user.roleLabel}
                    </Badge>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full text-destructive sm:w-auto"
                    disabled={Boolean(pendingId)}
                    onClick={() => {
                      if (lastAdmin) {
                        setLastAdminWarning(true);
                        return;
                      }
                      setConfirm({ type: 'revoke', user });
                    }}
                  >
                    Снять права администратора
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid gap-3">
        <h2 className="text-lg font-semibold">Подходящие сотрудники</h2>
        <Input
          aria-label="Поиск сотрудников"
          placeholder="ФИО или email"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="md:max-w-sm"
        />
        {eligibleQuery.isError ? (
          <ErrorState
            description="Не удалось загрузить сотрудников."
            onRetry={() => void eligibleQuery.refetch()}
          />
        ) : null}
        {eligibleQuery.isLoading ? <TableSkeleton /> : null}
        {!eligibleQuery.isLoading && eligible.length === 0 ? (
          <EmptyState
            title="Нет подходящих сотрудников"
            description="Назначить администратором можно руководителя СГР или ответственного инженера."
          />
        ) : null}
        <ul className="grid gap-2">
          {eligible.map((user) => (
            <li key={user.id}>
              <Card className="shadow-none">
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                  <UserAvatar name={user.fullName} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{user.fullName}</p>
                    <p className="truncate text-sm text-muted-foreground">{user.email}</p>
                    <p className="text-sm text-muted-foreground">{user.roleLabel}</p>
                  </div>
                  <Button
                    type="button"
                    className="min-h-11 w-full sm:w-auto"
                    disabled={Boolean(pendingId)}
                    onClick={() => setConfirm({ type: 'grant', user })}
                  >
                    Назначить администратором
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      </div>
      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(open) => (!open ? setConfirm(null) : undefined)}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {confirm?.type === 'revoke'
                ? 'Снять права администратора'
                : 'Назначить администратором'}
            </DialogTitle>
            <DialogDescription>
              {confirm?.type === 'revoke'
                ? `Сотрудник ${confirm.user.fullName} потеряет права администратора и должен будет войти снова.`
                : `Сотрудник ${confirm?.user.fullName ?? ''} получит права обычного администратора и должен будет войти снова.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirm(null)}
            >
              Отмена
            </Button>
            <Button
              type="button"
              variant={confirm?.type === 'revoke' ? 'outline' : 'default'}
              className={`min-h-11 ${confirm?.type === 'revoke' ? 'text-destructive' : ''}`}
              disabled={!confirm || pendingId === confirm.user.id}
              onClick={() => {
                if (confirm) {
                  void submit(confirm.type, confirm.user);
                }
              }}
            >
              {pendingId ? 'Сохранение…' : 'Подтвердить'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={lastAdminWarning} onOpenChange={setLastAdminWarning}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Нельзя снять права последнего администратора</DialogTitle>
            <DialogDescription>
              Сначала назначьте другого администратора, затем снимите права со текущего.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" className="min-h-11" onClick={() => setLastAdminWarning(false)}>
              Понятно
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
