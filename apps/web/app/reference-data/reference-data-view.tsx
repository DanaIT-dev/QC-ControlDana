'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConflictDialog } from '@/components/conflict-dialog';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, commandFetch } from '../../lib/command-api';

const TABS = [
  { id: 'property-objects', label: 'Объекты' },
  { id: 'organizations', label: 'Организации' },
  { id: 'work-types', label: 'Виды работ' },
  { id: 'defect-types', label: 'Виды дефектов' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function ReferenceDataView({
  csrfToken,
  canMutate,
}: {
  csrfToken: string;
  canMutate: boolean;
}) {
  const queryClient = useQueryClient();
  const visibleTabs = canMutate
    ? TABS
    : TABS.filter((item) => item.id === 'property-objects' || item.id === 'organizations');
  const [tab, setTab] = useState<TabId>('property-objects');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [createOpen, setCreateOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<{
    id: string;
    version: number;
    title: string;
  } | null>(null);
  const listQuery = useQuery({
    queryKey: ['reference', tab, search, status],
    queryFn: async () => {
      const params = new URLSearchParams({ status });
      if (search.trim().length >= 2) {
        params.set('search', search.trim());
      }
      const response = await fetch(`/api/reference-data/${tab}?${params.toString()}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('list');
      }
      return (await response.json()) as { items: Array<Record<string, unknown>> };
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

  const items = listQuery.data?.items ?? [];
  const showAddress = tab === 'property-objects' || tab === 'organizations';

  return (
    <section className="grid gap-4">
      <PageHeader
        title="Справочники"
        description={
          canMutate
            ? 'Объекты, организации, виды работ и дефектов.'
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
            Создать
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
              {showAddress ? <th className="px-3 py-3">Адрес</th> : null}
              <th className="px-3 py-3">Статус</th>
              {canMutate ? <th className="px-3 py-3">Действия</th> : null}
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
                  {showAddress ? (
                    <td className="max-w-[28rem] truncate px-3 py-3 text-muted-foreground">
                      {address || '—'}
                    </td>
                  ) : null}
                  <td className="px-3 py-3">
                    <Badge variant={active ? 'success' : 'outline'}>
                      {active ? 'Активно' : 'Архив'}
                    </Badge>
                  </td>
                  {canMutate ? (
                    <td className="px-3 py-3">
                      {active ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setArchiveTarget({ id, version, title })}
                        >
                          Архивировать
                        </Button>
                      ) : (
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
                      )}
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
                {showAddress && address ? (
                  <p className="text-sm break-words text-muted-foreground">{address}</p>
                ) : null}
                <Badge variant={active ? 'success' : 'outline'} className="w-fit">
                  {active ? 'Активно' : 'Архив'}
                </Badge>
                {canMutate ? (
                  active ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setArchiveTarget({ id, version, title })}
                    >
                      Архивировать
                    </Button>
                  ) : (
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
                  )
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
      {canMutate && createOpen ? (
        <CreateReferenceDialog
          tab={tab}
          onClose={() => setCreateOpen(false)}
          onCreate={(body) => {
            void mutate(`/api/reference-data/${tab}`, 'POST', body);
            setCreateOpen(false);
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
  onClose,
  onCreate,
}: {
  tab: TabId;
  onClose: () => void;
  onCreate: (body: unknown) => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            if (tab === 'property-objects') {
              onCreate({ name: form.get('name'), address: form.get('address') });
            } else if (tab === 'organizations') {
              onCreate({
                officialName: form.get('officialName'),
                postalAddress: form.get('postalAddress'),
                email: form.get('email'),
                phone: form.get('phone'),
                contactPerson: form.get('contactPerson'),
                roles: ['LIABLE_CONTRACTOR'],
              });
            } else {
              onCreate({ code: form.get('code'), name: form.get('name') });
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Новая запись</DialogTitle>
          </DialogHeader>
          {tab === 'property-objects' ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="ref-name">Название объекта</Label>
                <Input id="ref-name" name="name" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ref-address">Адрес объекта</Label>
                <Input id="ref-address" name="address" required />
              </div>
            </>
          ) : null}
          {tab === 'organizations' ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="org-name">Название организации</Label>
                <Input id="org-name" name="officialName" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="org-address">Адрес организации</Label>
                <Input id="org-address" name="postalAddress" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="org-email">Почта организации</Label>
                <Input id="org-email" name="email" type="email" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="org-phone">Телефон организации</Label>
                <Input id="org-phone" name="phone" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="org-contact">Контактное лицо</Label>
                <Input id="org-contact" name="contactPerson" required />
              </div>
            </>
          ) : null}
          {tab === 'work-types' || tab === 'defect-types' ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="ref-code">Код</Label>
                <Input id="ref-code" name="code" required />
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
            <Button type="submit">Создать</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
