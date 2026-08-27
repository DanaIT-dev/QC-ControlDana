'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MultiSelect } from '@/components/multi-select';
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
import { queryKeys } from '../../../lib/query-keys';

interface Lookups {
  propertyObjects: Array<{ id: string; name: string }>;
  customers: Array<{ id: string; officialName: string }>;
  defectTypes: Array<{ id: string; name: string }>;
  responsibleEngineers: Array<{ id: string; fullName: string }>;
  liableOrganizations: Array<{ id: string; officialName: string }>;
}

export interface DraftDefect {
  key: string;
  location: string;
  defectTypeId: string;
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
  const lookups = useQuery({
    queryKey: queryKeys.lookups,
    queryFn: async () => {
      const response = await fetch('/api/operations/lookups', { credentials: 'include' });
      if (!response.ok) {
        throw new Error('lookups');
      }
      return (await response.json()) as Lookups;
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
  const idempotencyKeyRef = useRef<string | null>(null);

  function readIdempotencyKey() {
    idempotencyKeyRef.current ??= crypto.randomUUID();
    return idempotencyKeyRef.current;
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
          <div className="grid gap-1.5">
            <Label htmlFor="object">Объект</Label>
            <Select value={objectId} onValueChange={setObjectId}>
              <SelectTrigger id="object" aria-label="Объект">
                <SelectValue placeholder="Выберите объект" />
              </SelectTrigger>
              <SelectContent>
                {(data?.propertyObjects ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="customer">Заказчик</Label>
            <Select value={customerOrganizationId} onValueChange={setCustomerOrganizationId}>
              <SelectTrigger id="customer" aria-label="Заказчик">
                <SelectValue placeholder="Выберите заказчика" />
              </SelectTrigger>
              <SelectContent>
                {(data?.customers ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.officialName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
          canRemove={defects.length > 1}
          onRemove={() =>
            setDefects((current) => current.filter((_, itemIndex) => itemIndex !== index))
          }
          onChange={(patch) => updateDefect(index, patch)}
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
    </div>
  );
}

function DraftDefectCard({
  item,
  index,
  lookups,
  canRemove,
  onRemove,
  onChange,
}: {
  item: DraftDefect;
  index: number;
  lookups: Lookups | undefined;
  canRemove: boolean;
  onRemove: () => void;
  onChange: (patch: Partial<DraftDefect>) => void;
}) {
  const fieldId = useId();
  const locationId = `${fieldId}-location`;
  const typeId = `${fieldId}-type`;
  const claimId = `${fieldId}-claim`;
  const planId = `${fieldId}-plan`;

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
              <Label htmlFor={typeId}>Вид дефекта</Label>
              <Select
                value={item.defectTypeId}
                onValueChange={(value) => onChange({ defectTypeId: value })}
              >
                <SelectTrigger id={typeId} aria-label="Вид дефекта">
                  <SelectValue placeholder="Выберите вид" />
                </SelectTrigger>
                <SelectContent>
                  {(lookups?.defectTypes ?? []).map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 md:col-span-2">
              <Label htmlFor={claimId}>Описание</Label>
              <Textarea
                id={claimId}
                value={item.claimDetails}
                onChange={(event) => onChange({ claimDetails: event.target.value })}
                required
              />
            </div>
            <MultiSelect
              label="Ответственные инженеры"
              options={(lookups?.responsibleEngineers ?? []).map((engineer) => ({
                id: engineer.id,
                label: engineer.fullName,
              }))}
              values={item.responsibleEngineerIds}
              onChange={(responsibleEngineerIds) => onChange({ responsibleEngineerIds })}
            />
            <MultiSelect
              label="Виновные организации"
              options={(lookups?.liableOrganizations ?? []).map((org) => ({
                id: org.id,
                label: org.officialName,
              }))}
              values={item.liableOrganizationIds}
              onChange={(liableOrganizationIds) => onChange({ liableOrganizationIds })}
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
