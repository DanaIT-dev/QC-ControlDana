'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ApiError, commandFetch } from '../../../lib/command-api';

interface Lookups {
  propertyObjects: Array<{ id: string; name: string }>;
  customers: Array<{ id: string; officialName: string }>;
  defectTypes: Array<{ id: string; name: string }>;
  responsibleEngineers: Array<{ id: string; fullName: string }>;
  liableOrganizations: Array<{ id: string; officialName: string }>;
}

interface DraftDefect {
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

function emptyDefect(): DraftDefect {
  return {
    key: crypto.randomUUID(),
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
    queryKey: ['lookups'],
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
  const [defects, setDefects] = useState<DraftDefect[]>([emptyDefect()]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

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
        idempotencyKey,
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
      router.replace(`/acts/${created.id}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Не удалось создать акт');
    } finally {
      setPending(false);
    }
  }

  const data = lookups.data;
  return (
    <section className="panel">
      <h1>Создание акта</h1>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="form-code">Форма</label>
          <select
            id="form-code"
            value={formCode}
            onChange={(event) => setFormCode(event.target.value as 'S1' | 'S23')}
          >
            <option value="S1">С-1</option>
            <option value="S23">С-23</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="object">Объект</label>
          <select
            id="object"
            value={objectId}
            onChange={(event) => setObjectId(event.target.value)}
            required
          >
            <option value="">Выберите объект</option>
            {(data?.propertyObjects ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="customer">Заказчик</label>
          <select
            id="customer"
            value={customerOrganizationId}
            onChange={(event) => setCustomerOrganizationId(event.target.value)}
            required
          >
            <option value="">Выберите заказчика</option>
            {(data?.customers ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.officialName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="issued-on">Дата акта</label>
          <input
            id="issued-on"
            type="date"
            value={issuedOn}
            onChange={(event) => setIssuedOn(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="doc-ref">Документ</label>
          <input
            id="doc-ref"
            value={signedDocumentRef}
            onChange={(event) => setSignedDocumentRef(event.target.value)}
          />
        </div>
      </div>
      <h2>Дефекты</h2>
      {defects.map((item, index) => (
        <article className="defect-card" key={item.key}>
          <p className="defect-card__kicker">Дефект {index + 1}</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor={`loc-${item.key}`}>Помещение</label>
              <input
                id={`loc-${item.key}`}
                value={item.location}
                onChange={(event) => updateDefect(index, { location: event.target.value })}
                required
              />
            </div>
            <div className="field">
              <label htmlFor={`type-${item.key}`}>Вид дефекта</label>
              <select
                id={`type-${item.key}`}
                value={item.defectTypeId}
                onChange={(event) => updateDefect(index, { defectTypeId: event.target.value })}
              >
                <option value="">Выберите вид</option>
                {(data?.defectTypes ?? []).map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`claim-${item.key}`}>Описание</label>
              <textarea
                id={`claim-${item.key}`}
                value={item.claimDetails}
                onChange={(event) => updateDefect(index, { claimDetails: event.target.value })}
                required
              />
            </div>
            <div className="field">
              <label htmlFor={`eng-${item.key}`}>Ответственные инженеры</label>
              <select
                id={`eng-${item.key}`}
                multiple
                value={item.responsibleEngineerIds}
                onChange={(event) =>
                  updateDefect(index, {
                    responsibleEngineerIds: [...event.target.selectedOptions].map(
                      (option) => option.value,
                    ),
                  })
                }
              >
                {(data?.responsibleEngineers ?? []).map((engineer) => (
                  <option key={engineer.id} value={engineer.id}>
                    {engineer.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`org-${item.key}`}>Виновные организации</label>
              <select
                id={`org-${item.key}`}
                multiple
                value={item.liableOrganizationIds}
                onChange={(event) =>
                  updateDefect(index, {
                    liableOrganizationIds: [...event.target.selectedOptions].map(
                      (option) => option.value,
                    ),
                  })
                }
              >
                {(data?.liableOrganizations ?? []).map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.officialName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`plan-${item.key}`}>Плановый срок</label>
              <input
                id={`plan-${item.key}`}
                type="date"
                value={item.plannedDeadline}
                onChange={(event) => updateDefect(index, { plannedDeadline: event.target.value })}
              />
            </div>
          </div>
          {defects.length > 1 ? (
            <button
              type="button"
              className="ghost-button"
              onClick={() => setDefects(defects.filter((_, i) => i !== index))}
            >
              Удалить карточку
            </button>
          ) : null}
        </article>
      ))}
      <div className="toolbar">
        <button
          type="button"
          className="ghost-button"
          onClick={() => setDefects([...defects, emptyDefect()])}
        >
          Добавить дефект
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => void onCreate()}
          disabled={pending}
        >
          {pending ? 'Создание…' : 'Создать акт'}
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );

  function updateDefect(index: number, patch: Partial<DraftDefect>) {
    setDefects(defects.map((item, current) => (current === index ? { ...item, ...patch } : item)));
  }
}
