'use client';

import type { ObjectsDirectoryResponse } from '@sgr-registry/contracts';
import { OBJECTS_DIRECTORY_PAGE_SIZES, responsibleEngineerNotice } from '@sgr-registry/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DirectoryCombobox } from '@/components/directory-combobox';
import {
  DirectoryCreateDialogs,
  type DirectoryQuickCreateRequest,
} from '@/components/directory-create-dialogs';
import { EditPropertyObjectDialog } from '@/components/edit-property-object-dialog';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '../../lib/command-api';
import { formatCalendarDate } from '../../lib/registry-url';
import { queryKeys } from '../../lib/query-keys';
import {
  fetchObjectsDirectory,
  linkObjectResponsibleEngineer,
  createPropertyObject,
} from '../../lib/objects-api';

function emptyDash(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : '—';
}

export function ObjectsView({
  csrfToken,
  canManageLinks,
}: {
  csrfToken: string;
  canManageLinks: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const query = useMemo(() => {
    const page = Number.parseInt(params.get('page') ?? '1', 10);
    const pageSize = Number.parseInt(params.get('pageSize') ?? '20', 10);
    const statusParam = params.get('status');
    const status: 'ACTIVE' | 'ARCHIVED' | 'ALL' | undefined =
      statusParam === 'ALL' || statusParam === 'ARCHIVED' || statusParam === 'ACTIVE'
        ? statusParam
        : undefined;
    return {
      search: params.get('search') ?? '',
      responsibleEngineer: params.get('responsibleEngineer') ?? '',
      page: Number.isInteger(page) && page > 0 ? page : 1,
      pageSize: (OBJECTS_DIRECTORY_PAGE_SIZES as readonly number[]).includes(pageSize)
        ? (pageSize as (typeof OBJECTS_DIRECTORY_PAGE_SIZES)[number])
        : 20,
      status,
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
  const queryClient = useQueryClient();
  const engineersQuery = useQuery({
    queryKey: ['users', 'responsible-engineers'],
    enabled: canManageLinks,
    queryFn: async () => {
      const response = await fetch(
        '/api/users?role=RESPONSIBLE_ENGINEER&status=ACTIVE&pageSize=100',
        { credentials: 'include' },
      );
      if (!response.ok) {
        throw new Error('users');
      }
      return (await response.json()) as { items: Array<{ id: string; fullName: string }> };
    },
  });
  const [linkTarget, setLinkTarget] = useState<ObjectsDirectoryResponse['items'][number] | null>(
    null,
  );
  const [editTarget, setEditTarget] = useState<ObjectsDirectoryResponse['items'][number] | null>(
    null,
  );
  const [createOpen, setCreateOpen] = useState(false);

  function navigate(next: typeof query) {
    const nextParams = new URLSearchParams();
    if (next.search) {
      nextParams.set('search', next.search);
    }
    if (next.responsibleEngineer) {
      nextParams.set('responsibleEngineer', next.responsibleEngineer);
    }
    if (next.status && next.status !== 'ACTIVE') {
      nextParams.set('status', next.status);
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
        actions={
          data?.canCreate ? (
            <Button
              type="button"
              className="min-h-11 w-full sm:w-auto"
              onClick={() => setCreateOpen(true)}
            >
              Добавить объект
            </Button>
          ) : null
        }
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
        {data?.canEdit ? (
          <label className="grid min-w-0 gap-1 md:w-56">
            <span className="text-sm font-medium">Статус</span>
            <Select
              value={query.status ?? 'ACTIVE'}
              onValueChange={(value) =>
                navigate({
                  ...query,
                  page: 1,
                  status: value as 'ACTIVE' | 'ARCHIVED' | 'ALL',
                })
              }
            >
              <SelectTrigger aria-label="Статус объекта" className="min-h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">Активные</SelectItem>
                <SelectItem value="ARCHIVED">Архивные</SelectItem>
                <SelectItem value="ALL">Все</SelectItem>
              </SelectContent>
            </Select>
          </label>
        ) : null}
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
            <ObjectsTable
              data={data!}
              canManageLinks={canManageLinks}
              canEdit={Boolean(data?.canEdit)}
              onManage={setLinkTarget}
              onEdit={setEditTarget}
            />
          </div>
          <div className="md:hidden">
            <ObjectsCards
              data={data!}
              canManageLinks={canManageLinks}
              canEdit={Boolean(data?.canEdit)}
              onManage={setLinkTarget}
              onEdit={setEditTarget}
            />
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
      {createOpen && data?.canCreate ? (
        <CreateObjectDialog
          csrfToken={csrfToken}
          engineers={data.createEngineerOptions}
          canRegisterEngineer={canManageLinks}
          onClose={() => setCreateOpen(false)}
          onSaved={async () => {
            setCreateOpen(false);
            await queryClient.invalidateQueries({ queryKey: queryKeys.objects.list(query) });
          }}
        />
      ) : null}
      {editTarget && data?.canEdit ? (
        <EditPropertyObjectDialog
          csrfToken={csrfToken}
          target={{
            id: editTarget.id,
            version: editTarget.version,
            name: editTarget.name,
            address: editTarget.address,
            active: editTarget.active,
          }}
          onClose={() => setEditTarget(null)}
          onSaved={async () => {
            setEditTarget(null);
            await queryClient.invalidateQueries({ queryKey: queryKeys.objects.all });
          }}
        />
      ) : null}
      {linkTarget ? (
        <LinkEngineerDialog
          object={linkTarget}
          engineers={engineersQuery.data?.items ?? []}
          csrfToken={csrfToken}
          onClose={() => setLinkTarget(null)}
          onSaved={async () => {
            setLinkTarget(null);
            await queryClient.invalidateQueries({ queryKey: queryKeys.objects.list(query) });
          }}
        />
      ) : null}
    </div>
  );
}

function ObjectsTable({
  data,
  canManageLinks,
  canEdit,
  onManage,
  onEdit,
}: {
  data: ObjectsDirectoryResponse;
  canManageLinks: boolean;
  canEdit: boolean;
  onManage: (item: ObjectsDirectoryResponse['items'][number]) => void;
  onEdit: (item: ObjectsDirectoryResponse['items'][number]) => void;
}) {
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
            {canEdit ? <th className="px-3 py-3">Действия</th> : null}
          </tr>
        </thead>
        <tbody>
          {data.items.map((item) => (
            <tr key={item.id} className="border-b align-top">
              <td className="max-w-[22rem] px-3 py-3 font-medium break-words">
                <span className="inline-flex flex-wrap items-center gap-2">
                  {item.name}
                  {item.active === false ? <Badge variant="outline">Неактивен</Badge> : null}
                </span>
              </td>
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
                  engineer={item.responsibleEngineer}
                  canManageLinks={canManageLinks}
                  onManage={() => onManage(item)}
                />
              </td>
              {canEdit ? (
                <td className="px-3 py-3">
                  <Button type="button" variant="outline" size="sm" onClick={() => onEdit(item)}>
                    Редактировать
                  </Button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ObjectsCards({
  data,
  canManageLinks,
  canEdit,
  onManage,
  onEdit,
}: {
  data: ObjectsDirectoryResponse;
  canManageLinks: boolean;
  canEdit: boolean;
  onManage: (item: ObjectsDirectoryResponse['items'][number]) => void;
  onEdit: (item: ObjectsDirectoryResponse['items'][number]) => void;
}) {
  return (
    <ul className="grid gap-3">
      {data.items.map((item) => (
        <li key={item.id}>
          <Card className="shadow-none">
            <CardContent className="grid gap-2 p-4">
              <h2 className="text-base font-semibold break-words">
                {item.name}
                {item.active === false ? (
                  <Badge variant="outline" className="ml-2 align-middle">
                    Неактивен
                  </Badge>
                ) : null}
              </h2>
              <p className="text-sm break-words">{emptyDash(item.address)}</p>
              <p className="text-sm">
                Принят в эксплуатацию: {formatCalendarDate(item.commissionedAt)}
              </p>
              <p className="text-sm">Гарантия до: {formatCalendarDate(item.warrantyEndsAt)}</p>
              <ResponsibleCell
                engineer={item.responsibleEngineer}
                canManageLinks={canManageLinks}
                onManage={() => onManage(item)}
              />
              {canEdit ? (
                <Button type="button" variant="outline" onClick={() => onEdit(item)}>
                  Редактировать
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function ResponsibleCell({
  engineer,
  canManageLinks,
  onManage,
}: {
  engineer: ObjectsDirectoryResponse['items'][number]['responsibleEngineer'];
  canManageLinks: boolean;
  onManage: () => void;
}) {
  if (!engineer) {
    return (
      <div className="grid min-w-0 gap-0.5">
        <span>—</span>
        {canManageLinks ? (
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onManage}>
            Связать
          </Button>
        ) : null}
      </div>
    );
  }
  const notice = responsibleEngineerNotice(engineer);
  return (
    <div className="grid min-w-0 gap-0.5">
      <p className="break-words">Ответственный: {engineer.fullName}</p>
      {notice ? <p className="text-[12px] text-muted-foreground">{notice}</p> : null}
      {canManageLinks ? (
        <Button type="button" variant="outline" size="sm" className="mt-1 w-fit" onClick={onManage}>
          {engineer.linked ? 'Изменить привязку' : 'Связать'}
        </Button>
      ) : null}
    </div>
  );
}

function LinkEngineerDialog({
  object,
  engineers,
  csrfToken,
  onClose,
  onSaved,
}: {
  object: ObjectsDirectoryResponse['items'][number];
  engineers: Array<{ id: string; fullName: string }>;
  csrfToken: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const currentId = object.responsibleEngineer?.linked ? object.responsibleEngineer.id : '';
  const [userId, setUserId] = useState(currentId || engineers[0]?.id || '');
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ответственный инженер</DialogTitle>
        </DialogHeader>
        <DirectoryCombobox
          label="Учётная запись инженера"
          options={engineers.map((item) => ({ id: item.id, label: item.fullName }))}
          value={userId}
          onChange={setUserId}
          emptyText="Нет активных ответственных инженеров"
        />
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          {object.responsibleEngineer?.linked ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void (async () => {
                  try {
                    await linkObjectResponsibleEngineer(object.id, null, csrfToken);
                    toast.success('Привязка снята');
                    await onSaved();
                  } catch (error) {
                    toast.error(error instanceof ApiError ? error.message : 'Ошибка');
                  }
                })();
              }}
            >
              Снять привязку
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button
            type="button"
            disabled={!userId}
            onClick={() => {
              void (async () => {
                try {
                  await linkObjectResponsibleEngineer(object.id, userId, csrfToken);
                  toast.success('Привязка сохранена');
                  await onSaved();
                } catch (error) {
                  toast.error(error instanceof ApiError ? error.message : 'Ошибка');
                }
              })();
            }}
          >
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateObjectDialog({
  csrfToken,
  engineers,
  canRegisterEngineer,
  onClose,
  onSaved,
}: {
  csrfToken: string;
  engineers: Array<{ id: string; fullName: string }>;
  canRegisterEngineer: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [commissionedAt, setCommissionedAt] = useState('');
  const [warrantyEndsAt, setWarrantyEndsAt] = useState('');
  const [engineerId, setEngineerId] = useState('');
  const [engineerName, setEngineerName] = useState('');
  const [engineerOptions, setEngineerOptions] = useState(engineers);
  const [pending, setPending] = useState(false);
  const [quickCreate, setQuickCreate] = useState<DirectoryQuickCreateRequest | null>(null);
  return (
    <>
      <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Добавить объект</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                if (pending) {
                  return;
                }
                setPending(true);
                try {
                  await createPropertyObject(csrfToken, {
                    name,
                    address: address.trim() ? address : null,
                    commissionedAt: commissionedAt || null,
                    warrantyEndsAt: warrantyEndsAt || null,
                    responsibleEngineerId: engineerId ? engineerId : null,
                    responsibleEngineerName:
                      !engineerId && engineerName.trim() ? engineerName : null,
                  });
                  toast.success('Объект создан');
                  await onSaved();
                } catch (error) {
                  toast.error(
                    error instanceof ApiError ? error.message : 'Не удалось создать объект',
                  );
                } finally {
                  setPending(false);
                }
              })();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="object-name">Название объекта</Label>
              <Input
                id="object-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                className="min-h-11"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="object-address">Адрес</Label>
              <Input
                id="object-address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                className="min-h-11"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="object-commissioned">Дата приёмки в эксплуатацию</Label>
              <Input
                id="object-commissioned"
                type="date"
                value={commissionedAt}
                onChange={(event) => setCommissionedAt(event.target.value)}
                className="min-h-11"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="object-warranty">Дата окончания гарантии</Label>
              <Input
                id="object-warranty"
                type="date"
                value={warrantyEndsAt}
                onChange={(event) => setWarrantyEndsAt(event.target.value)}
                className="min-h-11"
              />
            </div>
            <DirectoryCombobox
              label="Ответственный инженер"
              options={engineerOptions.map((item) => ({ id: item.id, label: item.fullName }))}
              value={engineerId || 'none'}
              onChange={setEngineerId}
              noneOption={{ id: 'none', label: 'Не выбран' }}
              emptyText="Нет активных ответственных инженеров"
              addLabel={
                canRegisterEngineer ? 'Зарегистрировать ответственного инженера' : undefined
              }
              onAdd={
                canRegisterEngineer
                  ? (query) => setQuickCreate({ kind: 'responsible-engineer', query })
                  : undefined
              }
            />
            {!engineerId ? (
              <div className="grid gap-1.5">
                <Label htmlFor="object-engineer-name">ФИО ответственного</Label>
                <Input
                  id="object-engineer-name"
                  value={engineerName}
                  onChange={(event) => setEngineerName(event.target.value)}
                  placeholder="Василевич М.В."
                  className="min-h-11"
                />
              </div>
            ) : null}
            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={onClose}>
                Отмена
              </Button>
              <Button type="submit" disabled={pending || !name.trim()}>
                {pending ? 'Создание…' : 'Создать'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DirectoryCreateDialogs
        csrfToken={csrfToken}
        request={quickCreate}
        onClose={() => setQuickCreate(null)}
        onCreated={(kind, created) => {
          if (kind !== 'responsible-engineer') {
            return;
          }
          setEngineerOptions((current) =>
            current.some((item) => item.id === created.id)
              ? current
              : [...current, { id: created.id, fullName: created.label }],
          );
          setEngineerId(created.id);
        }}
      />
    </>
  );
}
