'use client';

import {
  canAccessReferenceKind,
  formatPersonShort,
  ORGANIZATION_ROLE_LABELS,
} from '@sgr-registry/domain';
import { ORGANIZATION_ROLES, type OrganizationRole, type UserRole } from '@sgr-registry/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { ConflictDialog } from '@/components/conflict-dialog';
import { DirectoryCombobox } from '@/components/directory-combobox';
import { personOption } from '@/lib/lookups';
import { EditPropertyObjectDialog } from '@/components/edit-property-object-dialog';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/states';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, commandFetch } from '../../lib/command-api';
import { queryKeys } from '../../lib/query-keys';

const TABS = [
  { id: 'property-objects', label: 'Объекты' },
  { id: 'organizations', label: 'Организации' },
  { id: 'work-types', label: 'Виды работ' },
  { id: 'defect-types', label: 'Виды дефектов' },
  {
    id: 'construction-work-organizations',
    label: 'Организации по выполнению строительных работ',
  },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function ReferenceDataView({
  csrfToken,
  canMutate,
  canEditConstruction,
  role,
}: {
  csrfToken: string;
  canMutate: boolean;
  canEditConstruction: boolean;
  role: UserRole;
}) {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const requestedId = searchParams.get('id');
  const visibleTabs = TABS.filter((item) => canAccessReferenceKind(role, item.id));
  const [tab, setTab] = useState<TabId>(() =>
    visibleTabs.some((item) => item.id === requestedTab)
      ? (requestedTab as TabId)
      : (visibleTabs[0]?.id ?? 'property-objects'),
  );
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [createOpen, setCreateOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<{
    id: string;
    version: number;
    title: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    version: number;
    title: string;
    kind: TabId;
  } | null>(null);
  const [editTarget, setEditTarget] = useState<{
    id: string;
    version: number;
    name: string;
    address: string;
    active: boolean;
  } | null>(null);
  const [orgEditTarget, setOrgEditTarget] = useState<{
    id: string;
    version: number;
    officialName: string;
    unp: string;
    postalAddress: string;
    email: string;
    phone: string;
    contactPerson: string;
    roles: OrganizationRole[];
  } | null>(null);
  const [constructionEditTarget, setConstructionEditTarget] = useState<{
    id: string;
    version: number;
    officialName: string;
    workSupplierOnObject: string;
    workExecution: string;
  } | null>(null);
  const listQuery = useQuery({
    queryKey: ['reference', tab, search, status],
    queryFn: async () => {
      const params = new URLSearchParams({ status });
      if (search.trim().length >= 2) {
        params.set('search', search.trim());
      }
      if (tab === 'construction-work-organizations') {
        params.set('pageSize', '100');
      }
      const response = await fetch(`/api/reference-data/${tab}?${params.toString()}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('list');
      }
      const data = (await response.json()) as {
        items: Array<Record<string, unknown>>;
        totalPages?: number;
      };
      const totalPages = data.totalPages ?? 1;
      if (tab !== 'construction-work-organizations' || totalPages <= 1) {
        return data;
      }
      const rest = await Promise.all(
        Array.from({ length: totalPages - 1 }, async (_, index) => {
          const pageParams = new URLSearchParams(params);
          pageParams.set('page', String(index + 2));
          const pageResponse = await fetch(
            `/api/reference-data/${tab}?${pageParams.toString()}`,
            { credentials: 'include' },
          );
          if (!pageResponse.ok) {
            throw new Error('list');
          }
          return (await pageResponse.json()) as { items: Array<Record<string, unknown>> };
        }),
      );
      return {
        ...data,
        items: data.items.concat(...rest.map((page) => page.items)),
      };
    },
  });

  async function mutate(path: string, method: 'POST' | 'PATCH', body: unknown) {
    try {
      await commandFetch(path, { method, csrfToken, body });
      toast.success('Справочник обновлён');
      await queryClient.invalidateQueries({ queryKey: ['reference'] });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        toast.error(error.message);
        return;
      }
      toast.error(error instanceof ApiError ? error.message : 'Ошибка');
    }
  }

  const lookups = useQuery({
    queryKey: queryKeys.lookups,
    enabled: canMutate,
    queryFn: async () => {
      const response = await fetch('/api/operations/lookups', { credentials: 'include' });
      if (!response.ok) {
        throw new Error('lookups');
      }
      return (await response.json()) as {
        responsibleEngineers: Array<{ id: string; fullName: string }>;
      };
    },
  });
  const engineerOptions = (lookups.data?.responsibleEngineers ?? []).map((engineer) =>
    personOption(engineer),
  );
  const items = listQuery.data?.items ?? [];
  const isConstruction = tab === 'construction-work-organizations';
  const canEditRows = isConstruction ? canEditConstruction : canMutate;
  const showAddress = tab === 'property-objects' || tab === 'organizations';
  const openedFromQuery = useRef<string | null>(null);

  useEffect(() => {
    if (!requestedId || items.length === 0 || openedFromQuery.current === requestedId) {
      return;
    }
    const match = items.find((item) => String(item.id) === requestedId);
    if (!match) {
      return;
    }
    openedFromQuery.current = requestedId;
    if (tab === 'property-objects') {
      setEditTarget({
        id: String(match.id),
        version: Number(match.version),
        name: String(match.name ?? ''),
        address: String(match.address ?? ''),
        active: Boolean(match.active),
      });
    }
    if (tab === 'organizations') {
      setOrgEditTarget(
        organizationEditFromItem(
          match,
          String(match.id),
          Number(match.version),
          String(match.officialName ?? ''),
        ),
      );
    }
  }, [requestedId, items, tab]);

  return (
    <section className="grid gap-4">
      <PageHeader
        title="Справочники"
        description={
          isConstruction
            ? 'Название берётся из справочника организаций. Здесь записывают, кто поставил работы на объекте и какие работы выполнены.'
            : canMutate
              ? 'Объекты, организации, виды работ и дефектов.'
              : visibleTabs.length > 2
                ? 'Просмотр объектов, организаций, видов работ и дефектов.'
                : 'Просмотр объектов и организаций.'
        }
      />
      <Tabs value={tab} onValueChange={(value) => setTab(value as TabId)}>
        <TabsList aria-label="Справочники" className="flex h-auto flex-wrap">
          {visibleTabs.map((item) => (
            <TabsTrigger key={item.id} value={item.id} role="tab">
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="flex flex-col gap-2 md:flex-row">
        <Input
          aria-label="Поиск справочника"
          placeholder="Поиск"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="md:max-w-sm"
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label="Статус" className="md:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Все</SelectItem>
            <SelectItem value="ACTIVE">Активные</SelectItem>
            <SelectItem value="ARCHIVED">Архивные</SelectItem>
          </SelectContent>
        </Select>
        {canMutate ? (
          <Button type="button" onClick={() => setCreateOpen(true)}>
            {isConstruction ? 'Добавить организацию' : 'Создать'}
          </Button>
        ) : null}
      </div>
      {listQuery.isError ? (
        <ErrorState
          description="Не удалось загрузить справочник."
          onRetry={() => void listQuery.refetch()}
        />
      ) : null}
      {listQuery.isLoading ? <TableSkeleton rows={5} /> : null}
      {!listQuery.isLoading && items.length === 0 ? (
        <EmptyState title="Нет записей" description="По текущим условиям справочник пуст." />
      ) : null}
      <div
        className={
          listQuery.isLoading || items.length === 0
            ? 'hidden'
            : 'hidden overflow-hidden rounded-[10px] border bg-card md:block'
        }
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-background text-left text-[12px] font-medium text-muted-foreground">
              <th className="px-3 py-3">Название</th>
              {isConstruction ? (
                <>
                  <th className="px-3 py-3">Поставщик работ на объекте</th>
                  <th className="px-3 py-3">Выполнение работ</th>
                </>
              ) : null}
              {showAddress ? <th className="px-3 py-3">Адрес</th> : null}
              {tab === 'organizations' ? <th className="px-3 py-3">Роли</th> : null}
              {tab === 'property-objects' ? (
                <th className="px-3 py-3">Ответственные инженеры</th>
              ) : null}
              <th className="px-3 py-3">Статус</th>
              {canEditRows ? <th className="px-3 py-3">Действия</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const id = String(item.id);
              const version = Number(item.version);
              const active = Boolean(item.active);
              const title = String(item.name ?? item.officialName ?? item.code);
              const address = String(item.address ?? item.postalAddress ?? '');
              return (
                <tr key={id} className="border-b">
                  <td className="px-3 py-3 font-medium">{title}</td>
                  {isConstruction ? (
                    <>
                      <td className="max-w-[20rem] truncate px-3 py-3 text-muted-foreground">
                        {textOrDash(item.workSupplierOnObject)}
                      </td>
                      <td className="max-w-[20rem] truncate px-3 py-3 text-muted-foreground">
                        {textOrDash(item.workExecution)}
                      </td>
                    </>
                  ) : null}
                  {showAddress ? (
                    <td className="max-w-[28rem] truncate px-3 py-3 text-muted-foreground">
                      {address || '—'}
                    </td>
                  ) : null}
                  {tab === 'organizations' ? (
                    <td className="max-w-[18rem] truncate px-3 py-3 text-muted-foreground">
                      {organizationRoleText(item)}
                    </td>
                  ) : null}
                  {tab === 'property-objects' ? (
                    <td className="max-w-[22rem] truncate px-3 py-3 text-muted-foreground">
                      {engineerNames(item)}
                    </td>
                  ) : null}
                  <td className="px-3 py-3">
                    <Badge variant={active ? 'success' : 'outline'}>
                      {active ? 'Активно' : 'Архив'}
                    </Badge>
                  </td>
                  {canEditRows ? (
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-2">
                        {isConstruction ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setConstructionEditTarget({
                                id,
                                version,
                                officialName: title,
                                workSupplierOnObject: String(item.workSupplierOnObject ?? ''),
                                workExecution: String(item.workExecution ?? ''),
                              })
                            }
                          >
                            Редактировать
                          </Button>
                        ) : null}
                        {tab === 'property-objects' ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setEditTarget({
                                id,
                                version,
                                name: title,
                                address,
                                active,
                              })
                            }
                          >
                            Редактировать
                          </Button>
                        ) : null}
                        {tab === 'organizations' ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setOrgEditTarget(organizationEditFromItem(item, id, version, title))
                            }
                          >
                            Редактировать
                          </Button>
                        ) : null}
                        {!isConstruction && active ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setArchiveTarget({ id, version, title })}
                          >
                            Архивировать
                          </Button>
                        ) : null}
                        {!isConstruction && !active ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              void mutate(`/api/reference-data/${tab}/${id}/restore`, 'POST', {
                                expectedVersion: version,
                              })
                            }
                          >
                            Восстановить
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setDeleteTarget({ id, version, title, kind: tab })}
                        >
                          Удалить
                        </Button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div
        className={listQuery.isLoading || items.length === 0 ? 'hidden' : 'grid gap-3 md:hidden'}
      >
        {items.map((item) => {
          const id = String(item.id);
          const version = Number(item.version);
          const active = Boolean(item.active);
          const title = String(item.name ?? item.officialName ?? item.code);
          const address = String(item.address ?? item.postalAddress ?? '');
          return (
            <Card key={id} className="shadow-none">
              <CardContent className="grid gap-2 p-4">
                <strong className="break-words">{title}</strong>
                {isConstruction ? (
                  <>
                    <p className="text-sm break-words text-muted-foreground">
                      Поставщик работ на объекте: {textOrDash(item.workSupplierOnObject)}
                    </p>
                    <p className="text-sm break-words text-muted-foreground">
                      Выполнение работ: {textOrDash(item.workExecution)}
                    </p>
                  </>
                ) : null}
                {showAddress && address ? (
                  <p className="text-sm break-words text-muted-foreground">{address}</p>
                ) : null}
                {tab === 'organizations' ? (
                  <p className="text-sm break-words text-muted-foreground">
                    Роли: {organizationRoleText(item)}
                  </p>
                ) : null}
                {tab === 'property-objects' ? (
                  <p className="text-sm break-words text-muted-foreground">
                    Ответственные инженеры: {engineerNames(item)}
                  </p>
                ) : null}
                <Badge variant={active ? 'success' : 'outline'} className="w-fit">
                  {active ? 'Активно' : 'Архив'}
                </Badge>
                {canEditRows ? (
                  <>
                    {isConstruction ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          setConstructionEditTarget({
                            id,
                            version,
                            officialName: title,
                            workSupplierOnObject: String(item.workSupplierOnObject ?? ''),
                            workExecution: String(item.workExecution ?? ''),
                          })
                        }
                      >
                        Редактировать
                      </Button>
                    ) : null}
                    {tab === 'property-objects' ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          setEditTarget({
                            id,
                            version,
                            name: title,
                            address,
                            active,
                          })
                        }
                      >
                        Редактировать
                      </Button>
                    ) : null}
                    {tab === 'organizations' ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          setOrgEditTarget(organizationEditFromItem(item, id, version, title))
                        }
                      >
                        Редактировать
                      </Button>
                    ) : null}
                    {!isConstruction && active ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setArchiveTarget({ id, version, title })}
                      >
                        Архивировать
                      </Button>
                    ) : null}
                    {!isConstruction && !active ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          void mutate(`/api/reference-data/${tab}/${id}/restore`, 'POST', {
                            expectedVersion: version,
                          })
                        }
                      >
                        Восстановить
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setDeleteTarget({ id, version, title, kind: tab })}
                    >
                      Удалить
                    </Button>
                  </>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
      {canMutate && createOpen ? (
        <CreateReferenceDialog
          tab={tab}
          engineerOptions={engineerOptions}
          onClose={() => setCreateOpen(false)}
          onCreate={(body) => {
            const path = isConstruction
              ? '/api/reference-data/organizations'
              : `/api/reference-data/${tab}`;
            void mutate(path, 'POST', body);
            setCreateOpen(false);
          }}
        />
      ) : null}
      {editTarget ? (
        <EditPropertyObjectDialog
          csrfToken={csrfToken}
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={async () => {
            setEditTarget(null);
            await queryClient.invalidateQueries({ queryKey: ['reference'] });
          }}
        />
      ) : null}
      {constructionEditTarget ? (
        <EditConstructionWorkDialog
          csrfToken={csrfToken}
          target={constructionEditTarget}
          onClose={() => setConstructionEditTarget(null)}
          onSaved={async () => {
            setConstructionEditTarget(null);
            await queryClient.invalidateQueries({ queryKey: ['reference'] });
          }}
        />
      ) : null}
      {orgEditTarget ? (
        <EditOrganizationDialog
          csrfToken={csrfToken}
          target={orgEditTarget}
          onClose={() => setOrgEditTarget(null)}
          onSaved={async () => {
            setOrgEditTarget(null);
            await queryClient.invalidateQueries({ queryKey: ['reference'] });
            await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
          }}
        />
      ) : null}
      <AlertDialog
        open={Boolean(archiveTarget)}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Архивировать запись?</AlertDialogTitle>
            <AlertDialogDescription>
              {archiveTarget?.title} будет переведена в архив и перестанет предлагаться в новых
              актах.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!archiveTarget) {
                  return;
                }
                void mutate(`/api/reference-data/${tab}/${archiveTarget.id}/archive`, 'POST', {
                  expectedVersion: archiveTarget.version,
                });
              }}
            >
              Архивировать
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить запись?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === 'construction-work-organizations'
                ? `${deleteTarget.title} будет удалена из этого справочника. Карточка в справочнике «Организации» сохранится.`
                : `${deleteTarget?.title ?? 'Запись'} будет удалена без возможности восстановления. Если запись используется в актах, удаление будет отклонено.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleteTarget) {
                  return;
                }
                void mutate(
                  `/api/reference-data/${deleteTarget.kind}/${deleteTarget.id}/delete`,
                  'POST',
                  { expectedVersion: deleteTarget.version },
                );
              }}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ConflictDialog
        open={conflict}
        onRefresh={() => {
          setConflict(false);
          void queryClient.invalidateQueries({ queryKey: ['reference'] });
        }}
        onOpenChange={setConflict}
      />
    </section>
  );
}

function CreateReferenceDialog({
  tab,
  engineerOptions,
  onClose,
  onCreate,
}: {
  tab: TabId;
  engineerOptions: Array<{ id: string; label: string }>;
  onClose: () => void;
  onCreate: (body: unknown) => void;
}) {
  const [engineerIds, setEngineerIds] = useState<string[]>([]);
  const [roles, setRoles] = useState<OrganizationRole[]>(['LIABLE_CONTRACTOR']);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[min(100dvh,40rem)] overflow-y-auto">
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            if (tab === 'property-objects') {
              onCreate({
                name: form.get('name'),
                address: form.get('address'),
                responsibleEngineerIds: engineerIds,
              });
            } else if (tab === 'organizations' || tab === 'construction-work-organizations') {
              onCreate({
                officialName: form.get('officialName'),
                unp: String(form.get('unp') ?? '').trim() || null,
                postalAddress: String(form.get('postalAddress') ?? '').trim() || null,
                email: String(form.get('email') ?? '').trim() || null,
                phone: String(form.get('phone') ?? '').trim() || null,
                contactPerson: String(form.get('contactPerson') ?? '').trim() || null,
                roles,
              });
            } else {
              const code = String(form.get('code') ?? '').trim();
              onCreate({
                name: form.get('name'),
                ...(code ? { code } : {}),
              });
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {tab === 'construction-work-organizations' ? 'Добавить организацию' : 'Новая запись'}
            </DialogTitle>
          </DialogHeader>
          {tab === 'property-objects' ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="ref-name">Название объекта</Label>
                <Input id="ref-name" name="name" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ref-address">Адрес объекта</Label>
                <Input id="ref-address" name="address" />
              </div>
              <DirectoryCombobox
                label="Ответственные инженеры"
                options={engineerOptions}
                values={engineerIds}
                onValuesChange={setEngineerIds}
                emptyText="Нет активных ответственных инженеров"
              />
            </>
          ) : null}
          {tab === 'organizations' || tab === 'construction-work-organizations' ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="org-name">Название организации</Label>
                <Input id="org-name" name="officialName" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="org-unp">УНП</Label>
                <Input id="org-unp" name="unp" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="org-address">Адрес организации</Label>
                <Input id="org-address" name="postalAddress" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="org-email">Почта организации</Label>
                <Input id="org-email" name="email" type="email" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="org-phone">Телефон организации</Label>
                <Input id="org-phone" name="phone" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="org-contact">Контактное лицо</Label>
                <Input id="org-contact" name="contactPerson" />
              </div>
              <OrganizationRoleFields roles={roles} onChange={setRoles} />
            </>
          ) : null}
          {tab === 'work-types' || tab === 'defect-types' ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="ref-code">Код</Label>
                <Input id="ref-code" name="code" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ref-item-name">Название</Label>
                <Input id="ref-item-name" name="name" required />
              </div>
            </>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Отмена
            </Button>
            <Button
              type="submit"
              disabled={
                (tab === 'organizations' || tab === 'construction-work-organizations') &&
                roles.length === 0
              }
            >
              {tab === 'construction-work-organizations' ? 'Добавить' : 'Создать'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditOrganizationDialog({
  csrfToken,
  target,
  onClose,
  onSaved,
}: {
  csrfToken: string;
  target: {
    id: string;
    version: number;
    officialName: string;
    unp: string;
    postalAddress: string;
    email: string;
    phone: string;
    contactPerson: string;
    roles: OrganizationRole[];
  };
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [officialName, setOfficialName] = useState(target.officialName);
  const [unp, setUnp] = useState(target.unp);
  const [postalAddress, setPostalAddress] = useState(target.postalAddress);
  const [email, setEmail] = useState(target.email);
  const [phone, setPhone] = useState(target.phone);
  const [contactPerson, setContactPerson] = useState(target.contactPerson);
  const [roles, setRoles] = useState<OrganizationRole[]>(target.roles);
  const [pending, setPending] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[min(100dvh,40rem)] overflow-y-auto">
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) {
              return;
            }
            setPending(true);
            void (async () => {
              try {
                await commandFetch(`/api/reference-data/organizations/${target.id}`, {
                  method: 'PATCH',
                  csrfToken,
                  body: {
                    expectedVersion: target.version,
                    officialName,
                    unp: unp.trim() || null,
                    postalAddress: postalAddress.trim() || null,
                    email: email.trim() || null,
                    phone: phone.trim() || null,
                    contactPerson: contactPerson.trim() || null,
                    roles,
                  },
                });
                toast.success('Организация сохранена');
                await onSaved();
                onClose();
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : 'Не удалось сохранить');
              } finally {
                setPending(false);
              }
            })();
          }}
        >
          <DialogHeader>
            <DialogTitle>Редактировать организацию</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-org-name">Название организации</Label>
            <Input
              id="edit-org-name"
              value={officialName}
              onChange={(event) => setOfficialName(event.target.value)}
              required
              className="min-h-11"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-org-unp">УНП</Label>
            <Input
              id="edit-org-unp"
              value={unp}
              onChange={(event) => setUnp(event.target.value)}
              className="min-h-11"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-org-address">Адрес</Label>
            <Input
              id="edit-org-address"
              value={postalAddress}
              onChange={(event) => setPostalAddress(event.target.value)}
              className="min-h-11"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-org-email">Электронная почта</Label>
            <Input
              id="edit-org-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="min-h-11"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-org-phone">Телефон</Label>
            <Input
              id="edit-org-phone"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              className="min-h-11"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-org-contact">Контактное лицо</Label>
            <Input
              id="edit-org-contact"
              value={contactPerson}
              onChange={(event) => setContactPerson(event.target.value)}
              className="min-h-11"
            />
          </div>
          <OrganizationRoleFields roles={roles} onChange={setRoles} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending || !officialName.trim() || roles.length === 0}>
              {pending ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditConstructionWorkDialog({
  csrfToken,
  target,
  onClose,
  onSaved,
}: {
  csrfToken: string;
  target: {
    id: string;
    version: number;
    officialName: string;
    workSupplierOnObject: string;
    workExecution: string;
  };
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [workSupplierOnObject, setWorkSupplierOnObject] = useState(target.workSupplierOnObject);
  const [workExecution, setWorkExecution] = useState(target.workExecution);
  const [pending, setPending] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[min(100dvh,40rem)] overflow-y-auto">
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) {
              return;
            }
            setPending(true);
            void (async () => {
              try {
                await commandFetch(
                  `/api/reference-data/construction-work-organizations/${target.id}`,
                  {
                    method: 'PATCH',
                    csrfToken,
                    body: {
                      expectedVersion: target.version,
                      workSupplierOnObject: workSupplierOnObject.trim() || null,
                      workExecution: workExecution.trim() || null,
                    },
                  },
                );
                toast.success('Справочник обновлён');
                await onSaved();
              } catch (error) {
                toast.error(error instanceof ApiError ? error.message : 'Ошибка');
                setPending(false);
              }
            })();
          }}
        >
          <DialogHeader>
            <DialogTitle>Данные по организации</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="construction-name">Название</Label>
            <Input id="construction-name" value={target.officialName} readOnly />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="construction-supplier">Поставщик работ на объекте</Label>
            <Textarea
              id="construction-supplier"
              value={workSupplierOnObject}
              onChange={(event) => setWorkSupplierOnObject(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="construction-execution">Выполнение работ</Label>
            <Textarea
              id="construction-execution"
              value={workExecution}
              onChange={(event) => setWorkExecution(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function textOrDash(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : '—';
}

function organizationRoles(item: Record<string, unknown>): OrganizationRole[] {
  if (!Array.isArray(item.roles)) {
    return [];
  }
  return item.roles.filter((role): role is OrganizationRole =>
    (ORGANIZATION_ROLES as readonly string[]).includes(String(role)),
  );
}

function organizationRoleText(item: Record<string, unknown>): string {
  const roles = organizationRoles(item);
  return roles.length > 0 ? roles.map((role) => ORGANIZATION_ROLE_LABELS[role]).join(', ') : '—';
}

function organizationEditFromItem(
  item: Record<string, unknown>,
  id: string,
  version: number,
  title: string,
) {
  return {
    id,
    version,
    officialName: String(item.officialName ?? title),
    unp: String(item.unp ?? ''),
    postalAddress: String(item.postalAddress ?? ''),
    email: String(item.email ?? ''),
    phone: String(item.phone ?? ''),
    contactPerson: String(item.contactPerson ?? ''),
    roles: organizationRoles(item),
  };
}

function OrganizationRoleFields({
  roles,
  onChange,
}: {
  roles: OrganizationRole[];
  onChange: (roles: OrganizationRole[]) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">Роли</legend>
      {ORGANIZATION_ROLES.map((role) => (
        <label key={role} className="flex min-h-11 items-center gap-2 text-sm">
          <Checkbox
            checked={roles.includes(role)}
            onCheckedChange={(checked) => {
              onChange(
                checked === true
                  ? roles.includes(role)
                    ? roles
                    : [...roles, role]
                  : roles.filter((item) => item !== role),
              );
            }}
          />
          {ORGANIZATION_ROLE_LABELS[role]}
        </label>
      ))}
    </fieldset>
  );
}

function engineerNames(item: Record<string, unknown>): string {
  const rows = item.responsibleEngineers;
  if (!Array.isArray(rows) || rows.length === 0) {
    return '—';
  }
  const names = rows
    .map((row) =>
      row && typeof row === 'object' && 'fullName' in row
        ? formatPersonShort(
            typeof row.lastName === 'string' &&
              typeof row.firstName === 'string' &&
              row.lastName &&
              row.firstName
              ? {
                  lastName: row.lastName,
                  firstName: row.firstName,
                  middleName:
                    typeof row.middleName === 'string' && row.middleName.trim()
                      ? row.middleName
                      : null,
                }
              : String(row.fullName),
          )
        : '',
    )
    .filter(Boolean);
  return names.length > 0 ? names.join(', ') : '—';
}
