'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DirectoryCombobox } from '@/components/directory-combobox';
import {
  DirectoryCreateDialogs,
  type DirectoryKind,
  type DirectoryQuickCreateRequest,
} from '@/components/directory-create-dialogs';
import { LinkedObjectFields } from '@/components/linked-object-fields';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
import { queryKeys } from '../../../lib/query-keys';

export interface DraftDefect {
  key: string;
  location: string;
  defectTypeId: string;
  workTypeId: string;
  claimDetails: string;
  notes: string;
  responsibleEngineerIds: string[];
  liableOrganizationIds: string[];
  plannedDeadline: string;
  claimDeadline: string;
  thirdPartyDeadline: string;
}

export const INITIAL_DRAFT_DEFECT_KEY = 'draft-defect-0';

export function createDraftDefect(key: string): DraftDefect {
  return {
    key,
    location: '',
    defectTypeId: '',
    workTypeId: '',
    claimDetails: '',
    notes: '',
    responsibleEngineerIds: [],
    liableOrganizationIds: [],
    plannedDeadline: '',
    claimDeadline: '',
    thirdPartyDeadline: '',
  };
}

export function CreateActForm({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const lookups = useQuery({
    queryKey: queryKeys.lookups,
    queryFn: async () => {
      const response = await fetch('/api/operations/lookups', { credentials: 'include' });
      if (!response.ok) {
        throw new Error('lookups');
      }
      return (await response.json()) as OperationLookups;
    },
  });
  const [formCode, setFormCode] = useState<'S1' | 'S23'>('S1');
  const [objectId, setObjectId] = useState('');
  const [customerOrganizationId, setCustomerOrganizationId] = useState('');
  const [issuedOn, setIssuedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [signedDocumentRef, setSignedDocumentRef] = useState('');
  const [defects, setDefects] = useState<DraftDefect[]>(() => [
    createDraftDefect(INITIAL_DRAFT_DEFECT_KEY),
  ]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [quickCreate, setQuickCreate] = useState<DirectoryQuickCreateRequest | null>(null);
  const quickCreateTarget = useRef<{ defectIndex?: number; field?: string } | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  function readIdempotencyKey() {
    idempotencyKeyRef.current ??= crypto.randomUUID();
    return idempotencyKeyRef.current;
  }

  function patchLookups(updater: (current: OperationLookups) => OperationLookups) {
    queryClient.setQueryData(queryKeys.lookups, (current: OperationLookups | undefined) =>
      current ? updater(current) : current,
    );
  }

  function onDirectoryCreated(
    kind: DirectoryKind,
    created: { id: string; label: string; address?: string | null },
  ) {
    const target = quickCreateTarget.current;
    if (kind === 'property-objects') {
      patchLookups((current) => ({
        ...current,
        propertyObjects: current.propertyObjects.some((item) => item.id === created.id)
          ? current.propertyObjects
          : [
              ...current.propertyObjects,
              {
                id: created.id,
                name: created.label,
                address: created.address ?? '',
                active: true,
                responsibleEngineerIds: [],
              },
            ],
      }));
      setObjectId(created.id);
      return;
    }
    if (kind === 'organizations' && target?.field === 'customer') {
      patchLookups((current) => ({
        ...current,
        customers: current.customers.some((item) => item.id === created.id)
          ? current.customers
          : [...current.customers, { id: created.id, officialName: created.label }],
      }));
      setCustomerOrganizationId(created.id);
      return;
    }
    if (target?.defectIndex == null) {
      return;
    }
    const index = target.defectIndex;
    if (kind === 'defect-types') {
      patchLookups((current) => ({
        ...current,
        defectTypes: current.defectTypes.some((item) => item.id === created.id)
          ? current.defectTypes
          : [...current.defectTypes, { id: created.id, name: created.label }],
      }));
      updateDefect(index, { defectTypeId: created.id });
      return;
    }
    if (kind === 'work-types') {
      patchLookups((current) => ({
        ...current,
        workTypes: current.workTypes.some((item) => item.id === created.id)
          ? current.workTypes
          : [...current.workTypes, { id: created.id, name: created.label }],
      }));
      updateDefect(index, { workTypeId: created.id });
      return;
    }
    if (kind === 'organizations' && target.field === 'liable') {
      patchLookups((current) => ({
        ...current,
        liableOrganizations: current.liableOrganizations.some((item) => item.id === created.id)
          ? current.liableOrganizations
          : [...current.liableOrganizations, { id: created.id, officialName: created.label }],
      }));
      setDefects((current) =>
        current.map((item, itemIndex) =>
          itemIndex === index
            ? {
                ...item,
                liableOrganizationIds: item.liableOrganizationIds.includes(created.id)
                  ? item.liableOrganizationIds
                  : [...item.liableOrganizationIds, created.id],
              }
            : item,
        ),
      );
    }
  }

  async function onCreate() {
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const created = await commandFetch<{ id: string }>('/api/acts', {
        method: 'POST',
        csrfToken,
        idempotencyKey: readIdempotencyKey(),
        body: {
          formCode,
          objectId,
          customerOrganizationId,
          issuedOn,
          signedDocumentRef: signedDocumentRef || null,
          defectItems: defects.map((item) => ({
            location: item.location,
            defectTypeId: item.defectTypeId,
            ...(item.workTypeId ? { workTypeId: item.workTypeId } : {}),
            claimDetails: item.claimDetails,
            notes: item.notes || null,
            responsibleEngineerIds: item.responsibleEngineerIds,
            liableOrganizationIds: item.liableOrganizationIds,
            plannedDeadline: item.plannedDeadline || null,
            claimDeadline: item.claimDeadline || null,
            thirdPartyDeadline: item.thirdPartyDeadline || null,
          })),
        },
      });
      toast.success('Акт создан');
      router.replace(`/acts/${created.id}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось создать акт');
    } finally {
      setPending(false);
    }
  }

  const data = lookups.data;

  function updateDefect(index: number, patch: Partial<DraftDefect>) {
    setDefects((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    );
  }

  return (
    <div className="grid gap-4 pb-24">
      <PageHeader title="Создание акта" description="Укажите данные акта и хотя бы один дефект." />
      {lookups.isError ? (
        <ErrorState
          description="Не удалось загрузить справочники."
          onRetry={() => void lookups.refetch()}
        />
      ) : null}
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-lg">Данные акта</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="form-code">Форма</Label>
            <Select value={formCode} onValueChange={(value) => setFormCode(value as 'S1' | 'S23')}>
              <SelectTrigger id="form-code" aria-label="Форма">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="S1">С-1</SelectItem>
                <SelectItem value="S23">С-23</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <LinkedObjectFields
            objects={data?.propertyObjects ?? []}
            objectId={objectId}
            canCreate={data?.canCreate?.propertyObject}
            onAdd={({ query, field }) => {
              quickCreateTarget.current = { field: 'object' };
              setQuickCreate({ kind: 'property-objects', query, field });
            }}
            onObjectIdChange={(next) => {
              setObjectId(next);
              const allowed = new Set(
                (data?.propertyObjects ?? []).find((object) => object.id === next)
                  ?.responsibleEngineerIds ?? [],
              );
              setDefects((current) =>
                current.map((item) => ({
                  ...item,
                  responsibleEngineerIds: item.responsibleEngineerIds.filter((id) =>
                    allowed.has(id),
                  ),
                })),
              );
            }}
          />
          <div className="grid gap-1.5">
            {lookups.isSuccess &&
            (data?.customers ?? []).length === 0 &&
            !data?.canCreate?.organization ? (
              <p className="text-sm text-muted-foreground">Организации-заказчики не загружены</p>
            ) : (
              <DirectoryCombobox
                label="Заказчик"
                placeholder="Выберите заказчика"
                options={(data?.customers ?? []).map((item) => ({
                  id: item.id,
                  label: item.officialName,
                }))}
                value={customerOrganizationId}
                onChange={setCustomerOrganizationId}
                emptyText="Организации-заказчики не загружены"
                addLabel={data?.canCreate?.organization ? 'Добавить организацию' : undefined}
                onAdd={
                  data?.canCreate?.organization
                    ? (query) => {
                        quickCreateTarget.current = { field: 'customer' };
                        setQuickCreate({ kind: 'organizations', query, role: 'CUSTOMER' });
                      }
                    : undefined
                }
              />
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="issued-on">Дата акта</Label>
            <Input
              id="issued-on"
              type="date"
              value={issuedOn}
              onChange={(event) => setIssuedOn(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5 md:col-span-2">
            <Label htmlFor="doc-ref">Документ</Label>
            <Input
              id="doc-ref"
              value={signedDocumentRef}
              onChange={(event) => setSignedDocumentRef(event.target.value)}
            />
          </div>
        </CardContent>
      </Card>
      {defects.map((item, index) => (
        <DraftDefectCard
          key={item.key}
          item={item}
          index={index}
          lookups={data}
          lookupsFailed={lookups.isError}
          objectId={objectId}
          canRemove={defects.length > 1}
          onRemove={() =>
            setDefects((current) => current.filter((_, itemIndex) => itemIndex !== index))
          }
          onChange={(patch) => updateDefect(index, patch)}
          onQuickCreate={(next) => {
            quickCreateTarget.current = {
              defectIndex: index,
              field: next.kind === 'organizations' ? 'liable' : next.kind,
            };
            setQuickCreate(next);
          }}
        />
      ))}
      {error ? <ErrorState description={error} /> : null}
      <div className="sticky bottom-0 z-10 flex flex-wrap gap-2 border-t bg-background/95 py-3 backdrop-blur">
        <Button type="button" variant="outline" onClick={() => router.push('/registry')}>
          Отменить
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            setDefects((current) => [...current, createDraftDefect(crypto.randomUUID())])
          }
        >
          Добавить дефект
        </Button>
        <Button type="button" onClick={() => void onCreate()} disabled={pending}>
          {pending ? 'Создание…' : 'Создать акт'}
        </Button>
      </div>
      <DirectoryCreateDialogs
        csrfToken={csrfToken}
        request={quickCreate}
        onClose={() => setQuickCreate(null)}
        onCreated={onDirectoryCreated}
      />
    </div>
  );
}

function DraftDefectCard({
  item,
  index,
  lookups,
  lookupsFailed,
  objectId,
  canRemove,
  onRemove,
  onChange,
  onQuickCreate,
}: {
  item: DraftDefect;
  index: number;
  lookups: OperationLookups | undefined;
  lookupsFailed: boolean;
  objectId: string;
  canRemove: boolean;
  onRemove: () => void;
  onChange: (patch: Partial<DraftDefect>) => void;
  onQuickCreate: (next: DirectoryQuickCreateRequest) => void;
}) {
  const fieldId = useId();
  const locationId = `${fieldId}-location`;
  const claimId = `${fieldId}-claim`;
  const planId = `${fieldId}-plan`;
  const defectTypesEmpty = lookupsFailed || (lookups != null && lookups.defectTypes.length === 0);
  const canCreateDefectType = Boolean(lookups?.canCreate?.defectType);

  return (
    <Collapsible defaultOpen className="md:block">
      <Card className="defect-card shadow-none" data-draft-key={item.key}>
        <CardHeader className="flex flex-row items-center justify-between">
          <CollapsibleTrigger asChild>
            <button type="button" className="text-left">
              <CardTitle className="text-base">Дефект {index + 1}</CardTitle>
            </button>
          </CollapsibleTrigger>
          {canRemove ? (
            <Button type="button" variant="ghost" onClick={onRemove}>
              Удалить карточку
            </Button>
          ) : null}
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={locationId}>Помещение</Label>
              <Input
                id={locationId}
                value={item.location}
                onChange={(event) => onChange({ location: event.target.value })}
                required
              />
            </div>
            <div className="grid gap-1.5">
              {defectTypesEmpty && !canCreateDefectType ? (
                <>
                  <span className="text-[13px] font-medium text-foreground">Вид дефекта</span>
                  <p className="text-sm text-error-foreground">Виды дефектов не загружены</p>
                </>
              ) : (
                <DirectoryCombobox
                  label="Вид дефекта"
                  placeholder="Выберите вид"
                  options={(lookups?.defectTypes ?? []).map((type) => ({
                    id: type.id,
                    label: type.name,
                  }))}
                  value={item.defectTypeId}
                  onChange={(defectTypeId) => onChange({ defectTypeId })}
                  emptyText="Виды дефектов не загружены"
                  addLabel={canCreateDefectType ? 'Добавить вид дефекта' : undefined}
                  onAdd={
                    canCreateDefectType
                      ? (query) => onQuickCreate({ kind: 'defect-types', query })
                      : undefined
                  }
                />
              )}
            </div>
            <DirectoryCombobox
              label="Вид работ"
              placeholder="Не указан"
              options={(lookups?.workTypes ?? []).map((type) => ({
                id: type.id,
                label: type.name,
              }))}
              value={item.workTypeId || 'none'}
              onChange={(workTypeId) => onChange({ workTypeId })}
              noneOption={{ id: 'none', label: 'Не указан' }}
              addLabel={lookups?.canCreate?.workType ? 'Добавить вид работ' : undefined}
              onAdd={
                lookups?.canCreate?.workType
                  ? (query) => onQuickCreate({ kind: 'work-types', query })
                  : undefined
              }
            />
            <div className="grid gap-1.5 md:col-span-2">
              <Label htmlFor={claimId}>Описание</Label>
              <Textarea
                id={claimId}
                value={item.claimDetails}
                onChange={(event) => onChange({ claimDetails: event.target.value })}
                required
              />
            </div>
            <DirectoryCombobox
              label="Ответственные инженеры"
              options={engineersForObject(lookups, objectId)}
              values={item.responsibleEngineerIds}
              onValuesChange={(responsibleEngineerIds) => onChange({ responsibleEngineerIds })}
              emptyText={objectId ? 'Нет инженеров на объекте' : 'Сначала выберите объект'}
            />
            <DirectoryCombobox
              label="Виновные организации"
              options={(lookups?.liableOrganizations ?? []).map((org) => ({
                id: org.id,
                label: org.officialName,
              }))}
              values={item.liableOrganizationIds}
              onValuesChange={(liableOrganizationIds) => onChange({ liableOrganizationIds })}
              addLabel={lookups?.canCreate?.organization ? 'Добавить организацию' : undefined}
              onAdd={
                lookups?.canCreate?.organization
                  ? (query) =>
                      onQuickCreate({ kind: 'organizations', query, role: 'LIABLE_CONTRACTOR' })
                  : undefined
              }
            />
            <div className="grid gap-1.5">
              <Label htmlFor={planId}>Плановый срок</Label>
              <Input
                id={planId}
                type="date"
                value={item.plannedDeadline}
                onChange={(event) => onChange({ plannedDeadline: event.target.value })}
              />
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
