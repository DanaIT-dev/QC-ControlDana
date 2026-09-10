'use client';

import type {
  ActDetailDefectItem,
  ActDetailResponse,
  SafeUserProfile,
} from '@sgr-registry/contracts';
import {
  AUDIT_ACTION_LABELS,
  canStartAct,
  canViewProposalGroupBC,
  hasCapability,
  isStartableActStatus,
} from '@sgr-registry/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConflictDialog } from '@/components/conflict-dialog';
import { EmptyState, ErrorState } from '@/components/states';
import { PersonName } from '@/components/person-name';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, commandFetch } from '../../../lib/command-api';
import { engineersForObject, type OperationLookups } from '../../../lib/lookups';
import { historyKey, queryKeys } from '../../../lib/query-keys';
import { DirectoryCombobox } from '@/components/directory-combobox';
import {
  DirectoryCreateDialogs,
  type DirectoryQuickCreateRequest,
} from '@/components/directory-create-dialogs';

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
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);

  async function run(path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown) {
    try {
      await commandFetch(path, { method, csrfToken: user.csrfToken, body });
      toast.success('Изменения сохранены');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.act(act.id) }),
        queryClient.invalidateQueries({ queryKey: historyKey(act.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.registry.all }),
        item
          ? queryClient.invalidateQueries({ queryKey: queryKeys.defectItem(item.id) })
          : Promise.resolve(),
      ]);
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
    await queryClient.invalidateQueries({ queryKey: queryKeys.act(act.id) });
    await queryClient.invalidateQueries({ queryKey: historyKey(act.id) });
  }

  if (!item) {
    return (
      <div className="action-row flex flex-wrap gap-2">
        {canStartAct(user.role) && isStartableActStatus(act.status) ? (
          <Button
            type="button"
            disabled={starting}
            onClick={() => {
              if (startingRef.current) {
                return;
              }
              startingRef.current = true;
              setStarting(true);
              void run(`/api/acts/${act.id}/start`, 'POST', {}).finally(() => {
                startingRef.current = false;
                setStarting(false);
              });
            }}
          >
            Взять в работу
          </Button>
        ) : null}
        {hasCapability(user.role, 'EDIT_ACT_HEADER') ? (
          <HeaderEditor
            act={act}
            onSave={(body) => run(`/api/acts/${act.id}/header`, 'PATCH', body)}
          />
        ) : null}
        {hasCapability(user.role, 'ADD_DEFECT') ? (
          <AddDefectButton
            act={act}
            csrfToken={user.csrfToken}
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
        <AssignmentEditor
          act={act}
          item={item}
          csrfToken={user.csrfToken}
          onSave={(body) => run(`/api/defects/${item.id}/assignments`, 'PUT', body)}
        />
      ) : null}
      <DeadlineEditor
        item={item}
        user={user}
        onSave={(body) => run(`/api/defects/${item.id}/deadlines`, 'PATCH', body)}
      />
      {hasCapability(user.role, 'COMPLETE_DEFECT') &&
      item.status === 'IN_PROGRESS' &&
      act.status !== 'NEW' ? (
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
          csrfToken={user.csrfToken}
          canViewBC={canViewProposalGroupBC(user.role)}
          onSave={(slot, body) => run(`/api/defects/${item.id}/proposals/${slot}`, 'PUT', body)}
        />
      ) : null}
      <ConflictDialog open={conflict} onRefresh={() => void refresh()} onOpenChange={setConflict} />
    </div>
  );
}

function useOperationLookups() {
  return useQuery({
    queryKey: queryKeys.lookups,
    queryFn: async () => {
      const response = await fetch('/api/operations/lookups', { credentials: 'include' });
      if (!response.ok) {
        throw new Error('lookups');
      }
      return (await response.json()) as OperationLookups;
    },
  });
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
  csrfToken,
  onSave,
}: {
  act: ActDetailResponse;
  csrfToken: string;
  onSave: (body: unknown) => void;
}) {
  const lookups = useOperationLookups();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [engineerIds, setEngineerIds] = useState<string[]>([]);
  const [liableIds, setLiableIds] = useState<string[]>([]);
  const [defectTypeId, setDefectTypeId] = useState('');
  const [workTypeId, setWorkTypeId] = useState('');
  const [quickCreate, setQuickCreate] = useState<DirectoryQuickCreateRequest | null>(null);
  const engineerOptions = engineersForObject(lookups.data, act.objectId);
  const firstType = lookups.data?.defectTypes[0]?.id ?? '';

  function patchLookups(updater: (current: OperationLookups) => OperationLookups) {
    queryClient.setQueryData(queryKeys.lookups, (current: OperationLookups | undefined) =>
      current ? updater(current) : current,
    );
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Добавить дефект
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setEngineerIds(engineerOptions[0] ? [engineerOptions[0].id] : []);
            setLiableIds([]);
            setDefectTypeId(lookups.data?.defectTypes[0]?.id ?? '');
            setWorkTypeId('');
          }
        }}
      >
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
                defectTypeId: defectTypeId || firstType,
                workTypeId: workTypeId || undefined,
                claimDetails: form.get('claimDetails'),
                responsibleEngineerIds: engineerIds,
                liableOrganizationIds: liableIds,
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
            <DirectoryCombobox
              label="Вид дефекта"
              options={(lookups.data?.defectTypes ?? []).map((item) => ({
                id: item.id,
                label: item.name,
              }))}
              value={defectTypeId}
              onChange={setDefectTypeId}
              emptyText="Виды дефектов не загружены"
              addLabel={lookups.data?.canCreate?.defectType ? 'Добавить вид дефекта' : undefined}
              onAdd={
                lookups.data?.canCreate?.defectType
                  ? (query) => setQuickCreate({ kind: 'defect-types', query })
                  : undefined
              }
            />
            <DirectoryCombobox
              label="Вид работ"
              options={(lookups.data?.workTypes ?? []).map((item) => ({
                id: item.id,
                label: item.name,
              }))}
              value={workTypeId || 'none'}
              onChange={setWorkTypeId}
              noneOption={{ id: 'none', label: 'Не указан' }}
              addLabel={lookups.data?.canCreate?.workType ? 'Добавить вид работ' : undefined}
              onAdd={
                lookups.data?.canCreate?.workType
                  ? (query) => setQuickCreate({ kind: 'work-types', query })
                  : undefined
              }
            />
            <DirectoryCombobox
              label="Ответственные инженеры"
              options={engineerOptions}
              values={engineerIds}
              onValuesChange={setEngineerIds}
              emptyText="Нет инженеров на объекте"
            />
            <DirectoryCombobox
              label="Виновные организации"
              options={(lookups.data?.liableOrganizations ?? []).map((org) => ({
                id: org.id,
                label: org.officialName,
              }))}
              values={liableIds}
              onValuesChange={setLiableIds}
              addLabel={lookups.data?.canCreate?.organization ? 'Добавить организацию' : undefined}
              onAdd={
                lookups.data?.canCreate?.organization
                  ? (query) =>
                      setQuickCreate({ kind: 'organizations', query, role: 'LIABLE_CONTRACTOR' })
                  : undefined
              }
            />
            <DialogFooter>
              <Button type="submit">Добавить</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DirectoryCreateDialogs
        csrfToken={csrfToken}
        request={quickCreate}
        onClose={() => setQuickCreate(null)}
        onCreated={(kind, created) => {
          if (kind === 'defect-types') {
            patchLookups((current) => ({
              ...current,
              defectTypes: current.defectTypes.some((item) => item.id === created.id)
                ? current.defectTypes
                : [...current.defectTypes, { id: created.id, name: created.label }],
            }));
            setDefectTypeId(created.id);
          } else if (kind === 'work-types') {
            patchLookups((current) => ({
              ...current,
              workTypes: current.workTypes.some((item) => item.id === created.id)
                ? current.workTypes
                : [...current.workTypes, { id: created.id, name: created.label }],
            }));
            setWorkTypeId(created.id);
          } else if (kind === 'organizations') {
            patchLookups((current) => ({
              ...current,
              liableOrganizations: current.liableOrganizations.some(
                (item) => item.id === created.id,
              )
                ? current.liableOrganizations
                : [...current.liableOrganizations, { id: created.id, officialName: created.label }],
            }));
            setLiableIds((current) =>
              current.includes(created.id) ? current : [...current, created.id],
            );
          }
        }}
      />
    </>
  );
}

function AssignmentEditor({
  act,
  item,
  csrfToken,
  onSave,
}: {
  act: ActDetailResponse;
  item: ActDetailDefectItem;
  csrfToken: string;
  onSave: (body: unknown) => void;
}) {
  const lookups = useOperationLookups();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [engineerIds, setEngineerIds] = useState(
    item.responsibleEngineers.map((entry) => entry.id).filter((id): id is string => Boolean(id)),
  );
  const [liableIds, setLiableIds] = useState(item.liableOrganizations.map((entry) => entry.id));
  const [quickCreate, setQuickCreate] = useState<DirectoryQuickCreateRequest | null>(null);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          setEngineerIds(
            item.responsibleEngineers
              .map((entry) => entry.id)
              .filter((id): id is string => Boolean(id)),
          );
          setLiableIds(item.liableOrganizations.map((entry) => entry.id));
          setOpen(true);
        }}
      >
        Изменить ответственных
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ответственные</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              onSave({
                expectedVersion: item.version,
                responsibleEngineerIds: engineerIds,
                liableOrganizationIds: liableIds,
                confirmRemoveLastEngineer: engineerIds.length === 0,
              });
              setOpen(false);
            }}
          >
            <DirectoryCombobox
              label="Ответственные инженеры"
              options={engineersForObject(lookups.data, act.objectId)}
              values={engineerIds}
              onValuesChange={setEngineerIds}
              emptyText="Нет инженеров на объекте"
            />
            <DirectoryCombobox
              label="Виновные организации"
              options={(lookups.data?.liableOrganizations ?? []).map((org) => ({
                id: org.id,
                label: org.officialName,
              }))}
              values={liableIds}
              onValuesChange={setLiableIds}
              addLabel={lookups.data?.canCreate?.organization ? 'Добавить организацию' : undefined}
              onAdd={
                lookups.data?.canCreate?.organization
                  ? (query) =>
                      setQuickCreate({ kind: 'organizations', query, role: 'LIABLE_CONTRACTOR' })
                  : undefined
              }
            />
            <DialogFooter>
              <Button type="submit">Сохранить</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DirectoryCreateDialogs
        csrfToken={csrfToken}
        request={quickCreate}
        onClose={() => setQuickCreate(null)}
        onCreated={(kind, created) => {
          if (kind !== 'organizations') {
            return;
          }
          queryClient.setQueryData(queryKeys.lookups, (current: OperationLookups | undefined) =>
            current
              ? {
                  ...current,
                  liableOrganizations: current.liableOrganizations.some(
                    (item) => item.id === created.id,
                  )
                    ? current.liableOrganizations
                    : [
                        ...current.liableOrganizations,
                        { id: created.id, officialName: created.label },
                      ],
                }
              : current,
          );
          setLiableIds((current) =>
            current.includes(created.id) ? current : [...current, created.id],
          );
        }}
      />
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

function proposalForSlot(item: ActDetailDefectItem, slot: 'A' | 'B' | 'C') {
  if (slot === 'A') {
    return item.proposalA;
  }
  return item.proposalsBC?.find((proposal) => proposal.slot === slot) ?? null;
}

function ProposalEditor({
  item,
  csrfToken,
  canViewBC,
  onSave,
}: {
  item: ActDetailDefectItem;
  csrfToken: string;
  canViewBC: boolean;
  onSave: (slot: 'A' | 'B' | 'C', body: unknown) => void;
}) {
  const lookups = useOperationLookups();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState<'A' | 'B' | 'C'>('A');
  const [amount, setAmount] = useState(item.proposalA?.amount ?? '0.00');
  const [organizationId, setOrganizationId] = useState(item.proposalA?.organizationId ?? '');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [quickCreate, setQuickCreate] = useState<DirectoryQuickCreateRequest | null>(null);
  const slots: Array<'A' | 'B' | 'C'> = canViewBC ? ['A', 'B', 'C'] : ['A'];
  const contractors = lookups.data?.alternativeContractors ?? [];
  const currentProposal = proposalForSlot(item, slot);
  const organizationOptions =
    organizationId &&
    !contractors.some((org) => org.id === organizationId) &&
    currentProposal?.contractorName
      ? [{ id: organizationId, officialName: currentProposal.contractorName }, ...contractors]
      : contractors;

  useEffect(() => {
    if (!open || organizationId || !lookups.data?.alternativeContractors?.length) {
      return;
    }
    const fallback =
      proposalForSlot(item, slot)?.organizationId ??
      lookups.data.alternativeContractors[0]?.id ??
      '';
    if (fallback) {
      setOrganizationId(fallback);
    }
  }, [open, organizationId, lookups.data, item, slot]);

  function openEditor() {
    const initial = proposalForSlot(item, 'A');
    setSlot('A');
    setAmount(initial?.amount ?? '0.00');
    setOrganizationId(initial?.organizationId ?? contractors[0]?.id ?? '');
    setValidationError(null);
    setOpen(true);
  }

  function onSlotChange(next: 'A' | 'B' | 'C') {
    setSlot(next);
    const proposal = proposalForSlot(item, next);
    setAmount(proposal?.amount ?? '0.00');
    if (proposal?.organizationId) {
      setOrganizationId(proposal.organizationId);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={openEditor}>
        Сохранить предложение
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[min(100dvh,40rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Предложение</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!organizationId) {
                setValidationError('Выберите организацию');
                return;
              }
              setValidationError(null);
              onSave(slot, {
                amount,
                alternativeContractorOrganizationId: organizationId,
                expectedVersion: item.proposalA?.version,
              });
              setOpen(false);
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="proposal-slot">Слот</Label>
              <Select
                value={slot}
                onValueChange={(value) => onSlotChange(value as 'A' | 'B' | 'C')}
              >
                <SelectTrigger id="proposal-slot" aria-label="Слот">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  className="max-h-[min(16rem,var(--radix-select-content-available-height))]"
                >
                  {slots.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="proposal-amount">Сумма</Label>
              <Input
                id="proposal-amount"
                name="amount"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                required
              />
            </div>
            <DirectoryCombobox
              label="Организация"
              placeholder={lookups.isLoading ? 'Загрузка…' : 'Выберите организацию'}
              options={organizationOptions.map((org) => ({
                id: org.id,
                label: org.officialName,
              }))}
              value={organizationId}
              onChange={(next) => {
                setOrganizationId(next);
                setValidationError(null);
              }}
              loading={lookups.isLoading}
              disabled={lookups.isLoading}
              addLabel={lookups.data?.canCreate?.organization ? 'Добавить организацию' : undefined}
              onAdd={
                lookups.data?.canCreate?.organization
                  ? (query) =>
                      setQuickCreate({
                        kind: 'organizations',
                        query,
                        role: 'ALTERNATIVE_CONTRACTOR',
                      })
                  : undefined
              }
            />
            {validationError ? <p className="text-sm text-destructive">{validationError}</p> : null}
            <DialogFooter>
              <Button type="submit" disabled={lookups.isLoading}>
                Сохранить
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
          if (kind !== 'organizations') {
            return;
          }
          queryClient.setQueryData(queryKeys.lookups, (current: OperationLookups | undefined) =>
            current
              ? {
                  ...current,
                  alternativeContractors: [
                    ...(current.alternativeContractors ?? []).filter(
                      (item) => item.id !== created.id,
                    ),
                    { id: created.id, officialName: created.label },
                  ],
                }
              : current,
          );
          setOrganizationId(created.id);
          setValidationError(null);
        }}
      />
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
    queryKey: historyKey(actId),
    refetchOnMount: 'always',
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
          actorLastName: string | null;
          actorFirstName: string | null;
          actorMiddleName: string | null;
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
          {item.action === 'ACT_STARTED' ? (
            <>
              <p className="text-sm">
                Кто:{' '}
                {item.actorName && item.actorName !== 'SYSTEM' ? (
                  <PersonName
                    lastName={item.actorLastName}
                    firstName={item.actorFirstName}
                    middleName={item.actorMiddleName}
                    fullName={item.actorName}
                  />
                ) : (
                  'Система'
                )}
              </p>
              <p className="text-sm">
                Дата и время: {new Date(item.occurredAt).toLocaleString('ru-BY')}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {item.actorName && item.actorName !== 'SYSTEM' ? (
                  <PersonName
                    lastName={item.actorLastName}
                    firstName={item.actorFirstName}
                    middleName={item.actorMiddleName}
                    fullName={item.actorName}
                  />
                ) : (
                  'Система'
                )}{' '}
                · {new Date(item.occurredAt).toLocaleString('ru-BY')}
              </p>
              {item.reason ? <p className="text-sm">Причина: {item.reason}</p> : null}
              <p className="text-sm">
                Было: {summarize(item.oldValue)} → Стало: {summarize(item.newValue)}
              </p>
            </>
          )}
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
