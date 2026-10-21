'use client';

import { LISTABLE_USER_ROLES, USER_STATUSES, type UserRole } from '@sgr-registry/contracts';
import {
  assignableRolesFor,
  canEditEmployment,
  canEditUserProfile,
  canMutateManagedUser,
  hasCapability,
  isOversightRole,
  parsePersonNameForForm,
  parsePersonNameInput,
  roleLabel,
  ValidationError,
} from '@sgr-registry/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyIcon, ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConflictDialog } from '@/components/conflict-dialog';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { UserAvatar } from '@/components/user-avatar';
import { PersonName } from '@/components/person-name';
import { PersonNameFields } from '@/components/person-name-fields';
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
import { queryKeys } from '../../lib/query-keys';
import { formatTimestamp } from '../../lib/registry-url';

interface UserRow {
  id: string;
  lastName?: string;
  firstName?: string;
  middleName?: string | null;
  fullName: string;
  email: string;
  phone?: string | null;
  birthDate?: string | null;
  hiredOn?: string | null;
  contractEndsOn?: string | null;
  role: UserRole;
  roleLabel: string;
  status: (typeof USER_STATUSES)[number];
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  version: number;
  archivedAt?: string | null;
  passwordConfigured?: boolean;
  activeSessionsCount?: number;
}

export function UsersView({
  csrfToken,
  currentUserId,
  currentUserRole,
  canManage,
  canCreateUnassigned,
  canEditProfiles,
}: {
  csrfToken: string;
  currentUserId: string;
  currentUserRole: UserRole;
  canManage: boolean;
  canCreateUnassigned: boolean;
  canEditProfiles: boolean;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [cardUser, setCardUser] = useState<UserRow | null>(null);
  const canEditCard = canEditEmployment(currentUserRole);
  const showActions = canManage || canEditProfiles;
  const assignableRoles = assignableRolesFor(currentUserRole);
  const roleFilters = isOversightRole(currentUserRole)
    ? [...LISTABLE_USER_ROLES, 'SUPER_ADMIN' as const]
    : LISTABLE_USER_ROLES;
  const usersQuery = useQuery({
    queryKey: ['users', search, role, status, page],
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
      params.set('page', String(page));
      params.set('pageSize', '50');
      const response = await fetch(`/api/users?${params.toString()}`, { credentials: 'include' });
      if (!response.ok) {
        throw new Error('list');
      }
      return (await response.json()) as {
        items: UserRow[];
        page: number;
        pageSize: number;
        totalCount: number;
        totalPages: number;
      };
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
      await queryClient.invalidateQueries({ queryKey: queryKeys.objects.all });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        return;
      }
      toast.error(error instanceof ApiError ? error.message : 'Ошибка');
    }
  }

  const items = usersQuery.data?.items ?? [];
  const totalPages = usersQuery.data?.totalPages ?? 0;
  const currentPage = usersQuery.data?.page ?? page;

  return (
    <section className="grid gap-4">
      <PageHeader
        title="Пользователи"
        description="Учётные записи и роли доступа к реестру."
        actions={
          canManage || canCreateUnassigned ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              Добавить пользователя
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-2 md:flex-row">
        <Input
          aria-label="Поиск пользователей"
          placeholder="Поиск"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          className="md:max-w-sm"
        />
        <Select
          value={role}
          onValueChange={(value) => {
            setRole(value);
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="Роль" className="md:w-56">
            <SelectValue placeholder="Все роли" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Все роли</SelectItem>
            {roleFilters.map((item) => (
              <SelectItem key={item} value={item}>
                {roleLabel(item)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        >
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
            : 'hidden overflow-hidden rounded-md border bg-card md:block'
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
              {showActions ? <th className="px-3 py-3">Действия</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b">
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <UserAvatar name={item.fullName} />
                    <EmployeeNameButton user={item} onOpen={setCardUser} />
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
                {showActions ? (
                  <td className="px-3 py-3">
                    <UserActions
                      user={item}
                      actor={{ id: currentUserId, role: currentUserRole }}
                      canManage={canManage}
                      assignableRoles={assignableRoles}
                      csrfToken={csrfToken}
                      onMutate={mutate}
                      onConflict={() => setConflict(true)}
                    />
                  </td>
                ) : null}
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
                <div className="min-w-0">
                  <h2 className="text-base leading-6 font-semibold">
                    <EmployeeNameButton user={item} onOpen={setCardUser} />
                  </h2>
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
              {showActions ? (
                <UserActions
                  user={item}
                  actor={{ id: currentUserId, role: currentUserRole }}
                  canManage={canManage}
                  assignableRoles={assignableRoles}
                  csrfToken={csrfToken}
                  onMutate={mutate}
                  onConflict={() => setConflict(true)}
                />
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
      {totalPages > 1 ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="min-h-11 min-w-11"
            disabled={currentPage <= 1}
            aria-label="Назад"
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            <ChevronLeft />
          </Button>
          <span className="text-sm text-muted-foreground">
            {currentPage} / {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="min-h-11 min-w-11"
            disabled={currentPage >= totalPages}
            aria-label="Вперёд"
            onClick={() => setPage((value) => value + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      ) : null}
      {createOpen ? (
        <CreateUserDialog
          unassigned={canCreateUnassigned}
          assignableRoles={assignableRoles}
          onClose={() => setCreateOpen(false)}
          onCreate={async (body) => {
            await mutate(
              canCreateUnassigned ? '/api/super-admin/users' : '/api/users',
              'POST',
              body,
            );
            setCreateOpen(false);
          }}
        />
      ) : null}
      <TempPasswordDialog password={temporaryPassword} onClose={() => setTemporaryPassword(null)} />
      {cardUser ? (
        <EmployeeCardDialog
          user={cardUser}
          canEdit={canEditCard}
          csrfToken={csrfToken}
          onClose={() => setCardUser(null)}
          onConflict={() => {
            setCardUser(null);
            setConflict(true);
          }}
          onSaved={() => {
            setCardUser(null);
            void queryClient.invalidateQueries({ queryKey: ['users'] });
          }}
        />
      ) : null}
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
  actor,
  canManage,
  assignableRoles,
  csrfToken,
  onMutate,
  onConflict,
}: {
  user: UserRow;
  actor: { id: string; role: UserRole };
  canManage: boolean;
  assignableRoles: readonly UserRole[];
  csrfToken: string;
  onMutate: (path: string, method: 'POST' | 'PATCH', body: unknown) => Promise<void>;
  onConflict: () => void;
}) {
  const [roleOpen, setRoleOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const queryClient = useQueryClient();
  const canEdit = canEditUserProfile(actor, user);
  const canChangeRole = canMutateManagedUser(actor, user) && assignableRoles.length > 0;
  const canArchiveRestore = canManage && canMutateManagedUser(actor, user);
  const canResetPassword = canManage && canMutateManagedUser(actor, user);
  const canManageObjects =
    (user.role === 'RESPONSIBLE_ENGINEER' || user.role === 'CONTRACTOR_ENGINEER') &&
    (hasCapability(actor.role, 'MANAGE_USERS') ||
      hasCapability(actor.role, 'VIEW_ALL_BUSINESS_DATA'));
  const [objectsOpen, setObjectsOpen] = useState(false);
  if (!canEdit && !canChangeRole && !canArchiveRestore && !canResetPassword && !canManageObjects) {
    return null;
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="icon" aria-label="Действия">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canEdit ? (
            <DropdownMenuItem onSelect={() => setEditOpen(true)}>Редактировать</DropdownMenuItem>
          ) : null}
          {canChangeRole ? (
            <DropdownMenuItem onSelect={() => setRoleOpen(true)}>Изменить роль</DropdownMenuItem>
          ) : null}
          {canArchiveRestore && user.status === 'ACTIVE' && user.id !== actor.id ? (
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
          {canArchiveRestore && user.status === 'ARCHIVED' ? (
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
          {canManageObjects ? (
            <DropdownMenuItem onSelect={() => setObjectsOpen(true)}>Объекты</DropdownMenuItem>
          ) : null}
          {canResetPassword ? (
            <DropdownMenuItem
              onSelect={() =>
                void onMutate(`/api/users/${user.id}/reset-password`, 'POST', {
                  expectedVersion: user.version,
                })
              }
            >
              Сбросить пароль
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {roleOpen ? (
        <ChangeRoleDialog
          user={user}
          assignableRoles={assignableRoles}
          onClose={() => setRoleOpen(false)}
          onSave={(nextRole) => {
            setRoleOpen(false);
            void onMutate(`/api/users/${user.id}`, 'PATCH', {
              expectedVersion: user.version,
              role: nextRole,
            });
          }}
        />
      ) : null}
      {editOpen ? (
        <EditUserDialog
          user={user}
          csrfToken={csrfToken}
          requireCurrentPassword={actor.id === user.id}
          onClose={() => setEditOpen(false)}
          onConflict={onConflict}
          onSaved={async (requireReauth) => {
            setEditOpen(false);
            if (requireReauth) {
              toast.success('Данные сохранены. Войдите с новым адресом электронной почты.');
              window.location.assign('/login');
              return;
            }
            toast.success('Изменения сохранены');
            await queryClient.invalidateQueries({ queryKey: ['users'] });
            await queryClient.invalidateQueries({ queryKey: queryKeys.objects.all });
          }}
        />
      ) : null}
      {canManageObjects ? (
        <ObjectAssignmentsDialog
          userId={user.id}
          csrfToken={csrfToken}
          canAssign={hasCapability(actor.role, 'MANAGE_USERS')}
          open={objectsOpen}
          onOpenChange={setObjectsOpen}
        />
      ) : null}
    </>
  );
}

function ObjectAssignmentsDialog({
  userId,
  csrfToken,
  canAssign,
  open,
  onOpenChange,
}: {
  userId: string;
  csrfToken: string;
  canAssign: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [objectId, setObjectId] = useState('');
  const assignments = useQuery({
    queryKey: ['user-object-assignments', userId],
    enabled: open,
    queryFn: async () => {
      const response = await fetch(`/api/users/${userId}/object-assignments`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('objects');
      }
      return (await response.json()) as {
        canAssign: boolean;
        assignments: Array<{
          id: string;
          objectId: string;
          objectName: string;
          objectActive: boolean;
        }>;
        objects: Array<{ id: string; name: string }>;
      };
    },
  });
  const allowAssign = assignments.data ? assignments.data.canAssign && canAssign : canAssign;
  const assignedIds = new Set((assignments.data?.assignments ?? []).map((item) => item.objectId));
  const available = (assignments.data?.objects ?? []).filter((item) => !assignedIds.has(item.id));
  async function refresh() {
    setObjectId('');
    await assignments.refetch();
    await queryClient.invalidateQueries({ queryKey: queryKeys.objects.all });
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Объекты пользователя</DialogTitle>
          <DialogDescription>
            Инженер видит дефекты только назначенных объектов. Связь с организацией доступ не даёт.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {(assignments.data?.assignments ?? []).map((item) => (
            <div key={item.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {item.objectName}
                {item.objectActive ? '' : ' (архив)'}
              </span>
              {allowAssign ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    void commandFetch(`/api/users/${userId}/object-assignments/${item.id}/revoke`, {
                      method: 'POST',
                      csrfToken,
                    })
                      .then(() => refresh())
                      .catch((error: unknown) => {
                        toast.error(error instanceof Error ? error.message : 'Не удалось отозвать');
                      })
                  }
                >
                  Отозвать
                </Button>
              ) : null}
            </div>
          ))}
          {assignments.data && assignments.data.assignments.length === 0 ? (
            <p className="text-sm text-muted-foreground">Назначенных объектов нет.</p>
          ) : null}
          {allowAssign ? (
            <div className="grid gap-2">
              <Label htmlFor="engineer-object">Объект</Label>
              <Select value={objectId} onValueChange={setObjectId}>
                <SelectTrigger id="engineer-object">
                  <SelectValue placeholder="Выберите объект" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((object) => (
                    <SelectItem key={object.id} value={object.id}>
                      {object.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Просмотр без права изменения.</p>
          )}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Закрыть
          </Button>
          {allowAssign ? (
            <Button
              type="button"
              disabled={!objectId}
              onClick={() =>
                void commandFetch(`/api/users/${userId}/object-assignments`, {
                  method: 'POST',
                  csrfToken,
                  body: { objectId },
                })
                  .then(() => refresh())
                  .catch((error: unknown) => {
                    toast.error(error instanceof Error ? error.message : 'Не удалось назначить');
                  })
              }
            >
              Назначить
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({
  user,
  csrfToken,
  requireCurrentPassword,
  onClose,
  onSaved,
  onConflict,
}: {
  user: UserRow;
  csrfToken: string;
  requireCurrentPassword: boolean;
  onClose: () => void;
  onSaved: (requireReauth: boolean) => Promise<void>;
  onConflict: () => void;
}) {
  const parsed =
    user.lastName && user.firstName
      ? {
          lastName: user.lastName,
          firstName: user.firstName,
          middleName: user.middleName ?? null,
        }
      : parsePersonNameForForm(user.fullName);
  const [lastName, setLastName] = useState(parsed.lastName);
  const [firstName, setFirstName] = useState(parsed.firstName);
  const [middleName, setMiddleName] = useState(parsed.middleName ?? '');
  const [email, setEmail] = useState(user.email);
  const [currentPassword, setCurrentPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const emailChanged = email.trim().toLowerCase() !== user.email.toLowerCase();

  async function save() {
    setSaving(true);
    setErrors({});
    try {
      const result = await commandFetch<{ user: UserRow; requireReauth?: boolean }>(
        `/api/users/${user.id}/profile`,
        {
          method: 'PATCH',
          csrfToken,
          body: {
            expectedVersion: user.version,
            lastName,
            firstName,
            middleName: middleName.trim() === '' ? null : middleName,
            email,
            ...(requireCurrentPassword && emailChanged ? { currentPassword } : {}),
          },
        },
      );
      await onSaved(result.requireReauth === true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === 'STALE_WRITE') {
        onConflict();
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        setErrors({ email: error.message });
        return;
      }
      if (error instanceof ApiError && error.field) {
        setErrors({ [error.field]: error.message });
        return;
      }
      toast.error(error instanceof ApiError ? error.message : 'Ошибка');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !saving ? onClose() : undefined)}>
      <DialogContent>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Редактировать пользователя</DialogTitle>
            <DialogDescription>Имя, фамилия, отчество и электронная почта.</DialogDescription>
          </DialogHeader>
          <PersonNameFields
            idPrefix="edit-user"
            lastName={lastName}
            firstName={firstName}
            middleName={middleName}
            onLastNameChange={setLastName}
            onFirstNameChange={setFirstName}
            onMiddleNameChange={setMiddleName}
            errors={errors}
            disabled={saving}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="edit-user-email">Электронная почта</Label>
            <Input
              id="edit-user-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              aria-invalid={Boolean(errors.email)}
            />
            {errors.email ? <p className="text-sm text-destructive">{errors.email}</p> : null}
          </div>
          {requireCurrentPassword && emailChanged ? (
            <div className="grid gap-1.5">
              <Label htmlFor="edit-user-current-password">Текущий пароль</Label>
              <Input
                id="edit-user-current-password"
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
                autoComplete="current-password"
                aria-invalid={Boolean(errors.currentPassword)}
              />
              {errors.currentPassword ? (
                <p className="text-sm text-destructive">{errors.currentPassword}</p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Отменить
            </Button>
            <Button type="submit" disabled={saving}>
              Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateUserDialog({
  unassigned = false,
  assignableRoles,
  onClose,
  onCreate,
}: {
  unassigned?: boolean;
  assignableRoles: readonly UserRole[];
  onClose: () => void;
  onCreate: (body: unknown) => Promise<void>;
}) {
  const [lastName, setLastName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [email, setEmail] = useState('');
  const defaultRole = assignableRoles.includes('RESPONSIBLE_ENGINEER')
    ? 'RESPONSIBLE_ENGINEER'
    : (assignableRoles[0] ?? 'RESPONSIBLE_ENGINEER');
  const [role, setRole] = useState<UserRole>(defaultRole);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit() {
    setErrors({});
    try {
      const parts = parsePersonNameInput({
        lastName,
        firstName,
        middleName: middleName.trim() === '' ? null : middleName,
      });
      const body = {
        lastName: parts.lastName,
        firstName: parts.firstName,
        middleName: parts.middleName,
        email,
        ...(unassigned ? {} : { role }),
      };
      void onCreate(body);
    } catch (error) {
      if (error instanceof ValidationError) {
        setErrors({ [error.field]: error.message });
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Некорректное ФИО');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle id="create-user-title">Новый пользователь</DialogTitle>
            {unassigned ? (
              <DialogDescription>
                Учётная запись будет создана без рабочей роли. Роль назначит администратор.
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <PersonNameFields
            idPrefix="new-user"
            lastName={lastName}
            firstName={firstName}
            middleName={middleName}
            onLastNameChange={setLastName}
            onFirstNameChange={setFirstName}
            onMiddleNameChange={setMiddleName}
            errors={errors}
          />
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
          {unassigned ? null : (
            <div className="grid gap-1.5">
              <Label htmlFor="new-user-role">Роль</Label>
              <Select value={role} onValueChange={(value) => setRole(value as UserRole)}>
                <SelectTrigger id="new-user-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {assignableRoles.map((item) => (
                    <SelectItem key={item} value={item}>
                      {roleLabel(item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
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

function ChangeRoleDialog({
  user,
  assignableRoles,
  onClose,
  onSave,
}: {
  user: UserRow;
  assignableRoles: readonly UserRole[];
  onClose: () => void;
  onSave: (role: UserRole) => void;
}) {
  const initial = assignableRoles.includes(user.role)
    ? user.role
    : (assignableRoles[0] ?? user.role);
  const [role, setRole] = useState<UserRole>(initial);
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Изменить роль</DialogTitle>
        </DialogHeader>
        <Select value={role} onValueChange={(value) => setRole(value as UserRole)}>
          <SelectTrigger aria-label="Новая роль">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {assignableRoles.map((item) => (
              <SelectItem key={item} value={item}>
                {roleLabel(item)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button type="button" onClick={() => onSave(role)}>
            Сохранить
          </Button>
        </DialogFooter>
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

function EmployeeNameButton({ user, onOpen }: { user: UserRow; onOpen: (user: UserRow) => void }) {
  return (
    <button
      type="button"
      className="text-left font-medium text-primary underline-offset-4 hover:underline"
      onClick={() => onOpen(user)}
    >
      <PersonName
        lastName={user.lastName}
        firstName={user.firstName}
        middleName={user.middleName}
        fullName={user.fullName}
      />
    </button>
  );
}

function formatCardDate(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const [year, month, day] = value.split('-');
  if (!year || !month || !day) {
    return value;
  }
  return `${day}.${month}.${year}`;
}

function EmployeeCardDialog({
  user,
  canEdit,
  csrfToken,
  onClose,
  onConflict,
  onSaved,
}: {
  user: UserRow;
  canEdit: boolean;
  csrfToken: string;
  onClose: () => void;
  onConflict: () => void;
  onSaved: () => void;
}) {
  const [hiredOn, setHiredOn] = useState(user.hiredOn ?? '');
  const [contractEndsOn, setContractEndsOn] = useState(user.contractEndsOn ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) {
      return;
    }
    setSaving(true);
    try {
      await commandFetch(`/api/users/${user.id}/employment`, {
        method: 'PATCH',
        csrfToken,
        body: {
          expectedVersion: user.version,
          hiredOn: hiredOn || null,
          contractEndsOn: contractEndsOn || null,
        },
      });
      toast.success('Карточка сохранена');
      onSaved();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        onConflict();
        return;
      }
      toast.error(error instanceof ApiError ? error.message : 'Не удалось сохранить карточку');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Карточка сотрудника</DialogTitle>
          <DialogDescription>{user.email}</DialogDescription>
        </DialogHeader>
        <dl className="grid gap-3 text-sm">
          <div className="grid gap-1">
            <dt className="text-muted-foreground">Полное ФИО</dt>
            <dd className="font-medium">{user.fullName}</dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-muted-foreground">Номер телефона</dt>
            <dd>{user.phone?.trim() ? user.phone : '—'}</dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-muted-foreground">Дата рождения</dt>
            <dd>{formatCardDate(user.birthDate)}</dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-muted-foreground">Принят на работу с</dt>
            {canEdit ? (
              <dd>
                <Input
                  type="date"
                  value={hiredOn}
                  onChange={(event) => setHiredOn(event.target.value)}
                  aria-label="Принят на работу с"
                />
              </dd>
            ) : (
              <dd>{formatCardDate(user.hiredOn)}</dd>
            )}
          </div>
          <div className="grid gap-1">
            <dt className="text-muted-foreground">Контракт до</dt>
            {canEdit ? (
              <dd>
                <Input
                  type="date"
                  value={contractEndsOn}
                  onChange={(event) => setContractEndsOn(event.target.value)}
                  aria-label="Контракт до"
                />
              </dd>
            ) : (
              <dd>{formatCardDate(user.contractEndsOn)}</dd>
            )}
          </div>
        </dl>
        <DialogFooter>
          {canEdit ? (
            <Button type="button" onClick={() => void save()} disabled={saving}>
              {saving ? 'Сохранение…' : 'Сохранить'}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose}>
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
