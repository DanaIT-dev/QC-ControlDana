'use client';

import type {
  ActDetailDefectItem,
  ActDetailResponse,
  SafeUserProfile,
} from '@sgr-registry/contracts';
import { AUDIT_ACTION_LABELS, canViewProposalGroupBC, hasCapability } from '@sgr-registry/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConflictDialog } from '@/components/conflict-dialog';
import { EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, commandFetch } from '../../../lib/command-api';

export function ActOperations({
  act,
  item,
  user,
}: {
  act: ActDetailResponse;
  item?: ActDetailDefectItem;
  user: SafeUserProfile;
}) {
  const queryClient = useQueryClient();
  const [conflict, setConflict] = useState(false);

  async function run(path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown) {
    try {
      await commandFetch(path, { method, csrfToken: user.csrfToken, body });
      toast.success('Изменения сохранены');
      await queryClient.invalidateQueries({ queryKey: ['act', act.id] });
      await queryClient.invalidateQueries({ queryKey: ['registry'] });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        return;
      }
      toast.error(error instanceof ApiError ? error.message : 'Ошибка');
    }
  }

  async function refresh() {
    setConflict(false);
    await queryClient.invalidateQueries({ queryKey: ['act', act.id] });
  }

  if (!item) {
    return (
      <div className="action-row flex flex-wrap gap-2">
        {hasCapability(user.role, 'EDIT_ACT_HEADER') ? (
          <HeaderEditor
            act={act}
            onSave={(body) => run(`/api/acts/${act.id}/header`, 'PATCH', body)}
          />
        ) : null}
        {hasCapability(user.role, 'ADD_DEFECT') ? (
          <AddDefectButton
            act={act}
            onSave={(body) => run(`/api/acts/${act.id}/defects`, 'POST', body)}
          />
        ) : null}
        <ConflictDialog
          open={conflict}
          onRefresh={() => void refresh()}
          onOpenChange={setConflict}
        />
      </div>
    );
  }

  return (
    <div className="action-row flex flex-wrap gap-2">
      {hasCapability(user.role, 'EDIT_ASSIGNMENTS') ? (
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void run(`/api/defects/${item.id}/assignments`, 'PUT', {
              expectedVersion: item.version,
              responsibleEngineerIds: item.responsibleEngineers.map((entry) => entry.id),
              liableOrganizationIds: item.liableOrganizations.map((entry) => entry.id),
            })
          }
        >
          Изменить ответственных
        </Button>
      ) : null}
      <DeadlineEditor
        item={item}
        user={user}
        onSave={(body) => run(`/api/defects/${item.id}/deadlines`, 'PATCH', body)}
      />
      {hasCapability(user.role, 'COMPLETE_DEFECT') && item.status === 'IN_PROGRESS' ? (
        <Button
          type="button"
          onClick={() =>
            void run(`/api/defects/${item.id}/complete`, 'POST', { expectedVersion: item.version })
          }
        >
          Исполнить
        </Button>
      ) : null}
      {hasCapability(user.role, 'REOPEN_DEFECT') && item.status === 'COMPLETED' ? (
        <ReopenDialog
          onConfirm={(reason) =>
            void run(`/api/defects/${item.id}/reopen`, 'POST', {
              expectedVersion: item.version,
              reason,
            })
          }
        />
      ) : null}
      {hasCapability(user.role, 'MANAGE_PROPOSALS') ? (
        <ProposalEditor
          item={item}
          canViewBC={canViewProposalGroupBC(user.role)}
          onSave={(slot, body) => run(`/api/defects/${item.id}/proposals/${slot}`, 'PUT', body)}
        />
      ) : null}
      <ConflictDialog open={conflict} onRefresh={() => void refresh()} onOpenChange={setConflict} />
    </div>
  );
}

function HeaderEditor({
  act,
  onSave,
}: {
  act: ActDetailResponse;
  onSave: (body: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [issuedOn, setIssuedOn] = useState(act.issuedOn ?? '');
  const [signedDocumentRef, setSignedDocumentRef] = useState(act.signedDocumentRef ?? '');
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Изменить данные акта
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Данные акта</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              onSave({
                expectedVersion: act.version,
                objectId: act.objectId,
                customerOrganizationId: act.customerOrganizationId,
                issuedOn,
                signedDocumentRef,
              });
              setOpen(false);
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="issued-on">Дата акта</Label>
              <Input
                id="issued-on"
                type="date"
                value={issuedOn}
                onChange={(event) => setIssuedOn(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="doc-ref">Документ</Label>
              <Input
                id="doc-ref"
                value={signedDocumentRef}
                onChange={(event) => setSignedDocumentRef(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="submit">Сохранить</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AddDefectButton({
  act,
  onSave,
}: {
  act: ActDetailResponse;
  onSave: (body: unknown) => void;
}) {
  const lookups = useQuery({
    queryKey: ['lookups'],
    queryFn: async () => {
      const response = await fetch('/api/operations/lookups', { credentials: 'include' });
      return (await response.json()) as {
        defectTypes: Array<{ id: string; name: string }>;
        responsibleEngineers: Array<{ id: string; fullName: string }>;
        liableOrganizations: Array<{ id: string; officialName: string }>;
      };
    },
  });
  const [open, setOpen] = useState(false);
  const firstType = lookups.data?.defectTypes[0]?.id ?? '';
  const firstEngineer = lookups.data?.responsibleEngineers[0]?.id ?? '';
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Добавить дефект
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Новый дефект</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              onSave({
                expectedActVersion: act.version,
                location: form.get('location'),
                defectTypeId: form.get('defectTypeId') || firstType,
                claimDetails: form.get('claimDetails'),
                responsibleEngineerIds: firstEngineer ? [firstEngineer] : [],
                liableOrganizationIds: [],
              });
              setOpen(false);
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="new-location">Помещение</Label>
              <Input id="new-location" name="location" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-claim">Описание</Label>
              <Textarea id="new-claim" name="claimDetails" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-type">Вид дефекта</Label>
              <select
                id="new-type"
                name="defectTypeId"
                className="h-11 rounded-lg border border-input bg-white px-3 text-sm"
                defaultValue={firstType}
              >
                {(lookups.data?.defectTypes ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <DialogFooter>
              <Button type="submit">Добавить</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DeadlineEditor({
  item,
  user,
  onSave,
}: {
  item: ActDetailDefectItem;
  user: SafeUserProfile;
  onSave: (body: unknown) => void;
}) {
  const canPlan = hasCapability(user.role, 'EDIT_PLANNED_DEADLINE');
  const canClaim = hasCapability(user.role, 'EDIT_CLAIM_DEADLINE');
  const canThird = hasCapability(user.role, 'EDIT_THIRD_PARTY_DEADLINE');
  const [open, setOpen] = useState(false);
  if (!canPlan && !canClaim && !canThird) {
    return null;
  }
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Изменить сроки
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Сроки дефекта</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const reason = String(form.get('reason') ?? '');
              onSave({
                expectedVersion: item.version,
                ...(canPlan ? { plannedDeadline: form.get('plannedDeadline') || null } : {}),
                ...(canClaim ? { claimDeadline: form.get('claimDeadline') || null } : {}),
                ...(canThird ? { thirdPartyDeadline: form.get('thirdPartyDeadline') || null } : {}),
                ...(reason ? { reason } : {}),
              });
              setOpen(false);
            }}
          >
            {canPlan ? (
              <div className="grid gap-1.5">
                <Label>Плановый срок</Label>
                <Input
                  name="plannedDeadline"
                  type="date"
                  defaultValue={item.plannedDeadline ?? ''}
                />
              </div>
            ) : null}
            {canClaim ? (
              <div className="grid gap-1.5">
                <Label>Срок претензии</Label>
                <Input name="claimDeadline" type="date" defaultValue={item.claimDeadline ?? ''} />
              </div>
            ) : null}
            {canThird ? (
              <div className="grid gap-1.5">
                <Label>Срок третьей стороны</Label>
                <Input
                  name="thirdPartyDeadline"
                  type="date"
                  defaultValue={item.thirdPartyDeadline ?? ''}
                />
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label>Причина</Label>
              <Input name="reason" />
            </div>
            <DialogFooter>
              <Button type="submit">Сохранить</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProposalEditor({
  item,
  canViewBC,
  onSave,
}: {
  item: ActDetailDefectItem;
  canViewBC: boolean;
  onSave: (slot: 'A' | 'B' | 'C', body: unknown) => void;
}) {
  const lookups = useQuery({
    queryKey: ['lookups'],
    queryFn: async () => {
      const response = await fetch('/api/operations/lookups', { credentials: 'include' });
      return (await response.json()) as {
        alternativeContractors: Array<{ id: string; officialName: string }>;
      };
    },
  });
  const [open, setOpen] = useState(false);
  const slots: Array<'A' | 'B' | 'C'> = canViewBC ? ['A', 'B', 'C'] : ['A'];
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Сохранить предложение
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Предложение</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const slot = form.get('slot') as 'A' | 'B' | 'C';
              onSave(slot, {
                amount: form.get('amount'),
                alternativeContractorOrganizationId: form.get('organizationId'),
                expectedVersion: item.proposalA?.version,
              });
              setOpen(false);
            }}
          >
            <div className="grid gap-1.5">
              <Label>Слот</Label>
              <select
                name="slot"
                defaultValue="A"
                className="h-11 rounded-lg border border-input bg-white px-3 text-sm"
              >
                {slots.map((slot) => (
                  <option key={slot} value={slot}>
                    {slot}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label>Сумма</Label>
              <Input name="amount" defaultValue={item.proposalA?.amount ?? '0.00'} required />
            </div>
            <div className="grid gap-1.5">
              <Label>Организация</Label>
              <select
                name="organizationId"
                className="h-11 rounded-lg border border-input bg-white px-3 text-sm"
              >
                {(lookups.data?.alternativeContractors ?? []).map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.officialName}
                  </option>
                ))}
              </select>
            </div>
            <DialogFooter>
              <Button type="submit">Сохранить</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReopenDialog({ onConfirm }: { onConfirm: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Вернуть в работу
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Вернуть дефект в работу</AlertDialogTitle>
            <AlertDialogDescription>Укажите причину возврата.</AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Причина возврата в работу"
            aria-label="Причина возврата в работу"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!reason) {
                  return;
                }
                onConfirm(reason);
              }}
            >
              Вернуть
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function ActHistory({ actId }: { actId: string }) {
  const history = useQuery({
    queryKey: ['history', actId],
    queryFn: async () => {
      const response = await fetch(`/api/acts/${actId}/history`, { credentials: 'include' });
      if (!response.ok) {
        throw new Error('history');
      }
      return (await response.json()) as {
        items: Array<{
          id: string;
          action: string;
          actorName: string | null;
          occurredAt: string;
          reason: string | null;
          oldValue: unknown;
          newValue: unknown;
        }>;
      };
    },
  });
  if (history.isLoading) {
    return <p className="text-sm text-muted-foreground">Загрузка…</p>;
  }
  if (history.isError) {
    return (
      <ErrorState
        description="Не удалось загрузить историю"
        onRetry={() => void history.refetch()}
      />
    );
  }
  if ((history.data?.items.length ?? 0) === 0) {
    return (
      <EmptyState title="Записей нет" description="История изменений по этому акту пока пуста." />
    );
  }
  return (
    <ol className="timeline grid gap-3 border-l-2 border-brand/30 pl-4">
      {(history.data?.items ?? []).map((item) => (
        <li key={item.id} className="timeline__item grid gap-1">
          <strong>{AUDIT_ACTION_LABELS[item.action] ?? item.action}</strong>
          <p className="text-sm text-muted-foreground">
            {item.actorName ?? 'Система'} · {new Date(item.occurredAt).toLocaleString('ru-BY')}
          </p>
          {item.reason ? <p className="text-sm">Причина: {item.reason}</p> : null}
          <p className="text-sm">
            Было: {summarize(item.oldValue)} → Стало: {summarize(item.newValue)}
          </p>
        </li>
      ))}
    </ol>
  );
}

function summarize(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '—';
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([key, nested]) => `${key}: ${String(nested)}`)
    .join(', ');
}
