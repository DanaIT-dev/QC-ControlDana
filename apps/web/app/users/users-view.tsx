'use client';

import { USER_ROLES, USER_STATUSES } from '@sgr-registry/contracts';
import { roleLabel } from '@sgr-registry/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyIcon, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConflictDialog } from '@/components/conflict-dialog';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError, commandFetch } from '../../lib/command-api';
import { formatTimestamp } from '../../lib/registry-url';

interface UserRow {
  id: string;
  fullName: string;
  email: string;
  role: (typeof USER_ROLES)[number];
  roleLabel: string;
  status: (typeof USER_STATUSES)[number];
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  version: number;
}

export function UsersView({
  csrfToken,
  currentUserId,
}: {
  csrfToken: string;
  currentUserId: string;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const usersQuery = useQuery({
    queryKey: ['users', search, role, status],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search.trim().length >= 2) {
        params.set('search', search.trim());
      }
      if (role !== 'ALL') {
        params.set('role', role);
      }
      if (status !== 'ALL') {
        params.set('status', status);
      }
      const response = await fetch(`/api/users?${params.toString()}`, { credentials: 'include' });
      if (!response.ok) {
        throw new Error('list');
      }
      return (await response.json()) as { items: UserRow[] };
    },
  });

  async function mutate(path: string, method: 'POST' | 'PATCH', body: unknown) {
    try {
      const result = await commandFetch<{ temporaryPassword?: string }>(path, {
        method,
        csrfToken,
        body,
      });
      if (result.temporaryPassword) {
        setTemporaryPassword(result.temporaryPassword);
      }
      toast.success('Изменения сохранены');
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        return;
      }
      toast.error(error instanceof ApiError ? error.message : 'Ошибка');
    }
  }

  const items = usersQuery.data?.items ?? [];

  return (
    <section className="grid gap-4">
      <PageHeader
        title="Пользователи"
        description="Учётные записи и роли доступа к реестру."
        actions={
          <Button type="button" onClick={() => setCreateOpen(true)}>
            Добавить пользователя
          </Button>
        }
      />
      <div className="flex flex-col gap-2 md:flex-row">
        <Input
          aria-label="Поиск пользователей"
          placeholder="Поиск"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="md:max-w-sm"
        />
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger aria-label="Роль" className="md:w-56">
            <SelectValue placeholder="Все роли" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Все роли</SelectItem>
            {USER_ROLES.map((item) => (
              <SelectItem key={item} value={item}>
                {roleLabel(item)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label="Статус" className="md:w-48">
            <SelectValue placeholder="Все статусы" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Все статусы</SelectItem>
            <SelectItem value="ACTIVE">Активные</SelectItem>
            <SelectItem value="ARCHIVED">Архивные</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {usersQuery.isError ? (
        <ErrorState
          description="Не удалось загрузить пользователей."
          onRetry={() => void usersQuery.refetch()}
        />
      ) : null}
      {usersQuery.isLoading ? <TableSkeleton /> : null}
      {!usersQuery.isLoading && items.length === 0 ? (
        <EmptyState
          title="Нет пользователей"
          description="По текущим условиям ничего не найдено."
        />
      ) : null}
      <div
        className={
          usersQuery.isLoading || items.length === 0
            ? 'hidden'
            : 'hidden overflow-hidden rounded-[10px] border bg-card md:block'
        }
      >
        <table className="data-table w-full text-sm">
          <thead>
            <tr className="border-b bg-background text-left text-[12px] font-medium text-muted-foreground">
              <th className="px-3 py-3">Пользователь</th>
              <th className="px-3 py-3">Почта</th>
              <th className="px-3 py-3">Роль</th>
              <th className="px-3 py-3">Статус</th>
              <th className="px-3 py-3">Последний вход</th>
              <th className="px-3 py-3">Действия</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b">
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <UserAvatar name={item.fullName} />
                    <span className="font-medium">{item.fullName}</span>
                  </div>
                </td>
                <td className="px-3 py-3">{item.email}</td>
                <td className="px-3 py-3">
                  <Badge variant="secondary">{item.roleLabel}</Badge>
                </td>
                <td className="px-3 py-3">
                  <Badge variant={item.status === 'ACTIVE' ? 'success' : 'outline'}>
                    {item.status === 'ACTIVE' ? 'Активен' : 'Архив'}
                  </Badge>
                </td>
                <td className="px-3 py-3 text-muted-foreground">
                  {formatTimestamp(item.lastLoginAt)}
                </td>
                <td className="px-3 py-3">
                  <UserActions user={item} currentUserId={currentUserId} onMutate={mutate} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        className={usersQuery.isLoading || items.length === 0 ? 'hidden' : 'grid gap-3 md:hidden'}
      >
        {items.map((item) => (
          <Card key={item.id} className="shadow-none">
            <CardContent className="grid gap-2 p-4">
              <div className="flex items-center gap-2">
                <UserAvatar name={item.fullName} />
                <div>
                  <h2 className="text-base font-semibold">{item.fullName}</h2>
                  <p className="text-sm text-muted-foreground">{item.email}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{item.roleLabel}</Badge>
                <Badge variant={item.status === 'ACTIVE' ? 'success' : 'outline'}>
                  {item.status === 'ACTIVE' ? 'Активен' : 'Архив'}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Вход: {formatTimestamp(item.lastLoginAt)}
              </p>
              <UserActions user={item} currentUserId={currentUserId} onMutate={mutate} />
            </CardContent>
          </Card>
        ))}
      </div>
      {createOpen ? (
        <CreateUserDialog
          onClose={() => setCreateOpen(false)}
          onCreate={async (body) => {
            await mutate('/api/users', 'POST', body);
            setCreateOpen(false);
          }}
        />
      ) : null}
      <TempPasswordDialog password={temporaryPassword} onClose={() => setTemporaryPassword(null)} />
      <ConflictDialog
        open={conflict}
        onRefresh={() => {
          setConflict(false);
          void queryClient.invalidateQueries({ queryKey: ['users'] });
        }}
        onOpenChange={setConflict}
      />
    </section>
  );
}

function UserActions({
  user,
  currentUserId,
  onMutate,
}: {
  user: UserRow;
  currentUserId: string;
  onMutate: (path: string, method: 'POST' | 'PATCH', body: unknown) => Promise<void>;
}) {
  const nextRole = user.role === 'SGR_MANAGER' ? 'ADMIN' : 'SGR_MANAGER';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="icon" aria-label="Действия">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() =>
            void onMutate(`/api/users/${user.id}`, 'PATCH', {
              expectedVersion: user.version,
              role: nextRole,
            })
          }
        >
          Изменить роль
        </DropdownMenuItem>
        {user.status === 'ACTIVE' && user.id !== currentUserId ? (
          <DropdownMenuItem
            onSelect={() =>
              void onMutate(`/api/users/${user.id}/archive`, 'POST', {
                expectedVersion: user.version,
              })
            }
          >
            Архивировать
          </DropdownMenuItem>
        ) : null}
        {user.status === 'ARCHIVED' ? (
          <DropdownMenuItem
            onSelect={() =>
              void onMutate(`/api/users/${user.id}/restore`, 'POST', {
                expectedVersion: user.version,
              })
            }
          >
            Восстановить
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() =>
            void onMutate(`/api/users/${user.id}/reset-password`, 'POST', {
              expectedVersion: user.version,
            })
          }
        >
          Сбросить пароль
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CreateUserDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (body: unknown) => Promise<void>;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof USER_ROLES)[number]>('RESPONSIBLE_ENGINEER');
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void onCreate({ fullName, email, role });
          }}
        >
          <DialogHeader>
            <DialogTitle id="create-user-title">Новый пользователь</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="new-user-name">ФИО</Label>
            <Input
              id="new-user-name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-user-email">Электронная почта</Label>
            <Input
              id="new-user-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-user-role">Роль</Label>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as (typeof USER_ROLES)[number])}
            >
              <SelectTrigger id="new-user-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {USER_ROLES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {roleLabel(item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit">Создать</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TempPasswordDialog({
  password,
  onClose,
}: {
  password: string | null;
  onClose: () => void;
}) {
  if (!password) {
    return null;
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Временный пароль</DialogTitle>
          <DialogDescription>
            Временный пароль показывается один раз. Повторно показать пароль нельзя.
          </DialogDescription>
        </DialogHeader>
        <p className="temp-password rounded-lg bg-accent px-3 py-2 font-mono text-sm break-all">
          {password}
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(password)}
          >
            <CopyIcon data-icon="inline-start" />
            Скопировать
          </Button>
          <Button type="button" onClick={onClose}>
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
