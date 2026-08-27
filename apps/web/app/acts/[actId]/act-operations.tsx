'use client';

import type {
  ActDetailDefectItem,
  ActDetailResponse,
  SafeUserProfile,
} from '@sgr-registry/contracts';
import { AUDIT_ACTION_LABELS, hasCapability } from '@sgr-registry/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
  const [toast, setToast] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  async function run(path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown) {
    try {
      await commandFetch(path, { method, csrfToken: user.csrfToken, body });
      setToast('Изменения сохранены');
      await queryClient.invalidateQueries({ queryKey: ['act', act.id] });
      await queryClient.invalidateQueries({ queryKey: ['registry'] });
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : 'Ошибка');
    }
  }

  if (!item) {
    return (
      <div className="action-row">
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
        {hasCapability(user.role, 'VIEW_HISTORY') ? (
          <button type="button" className="ghost-button" onClick={() => setHistoryOpen(true)}>
            История изменений
          </button>
        ) : null}
        {historyOpen ? <HistoryPanel actId={act.id} onClose={() => setHistoryOpen(false)} /> : null}
        {toast ? (
          <p className="toast" role="status" aria-live="polite">
            {toast}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="action-row">
      {hasCapability(user.role, 'EDIT_ASSIGNMENTS') ? (
        <button
          type="button"
          className="ghost-button"
          onClick={() =>
            run(`/api/defects/${item.id}/assignments`, 'PUT', {
              expectedVersion: item.version,
              responsibleEngineerIds: item.responsibleEngineers.map((entry) => entry.id),
              liableOrganizationIds: item.liableOrganizations.map((entry) => entry.id),
            })
          }
        >
          Изменить ответственных
        </button>
      ) : null}
      <DeadlineEditor
        item={item}
        user={user}
        onSave={(body) => run(`/api/defects/${item.id}/deadlines`, 'PATCH', body)}
      />
      {hasCapability(user.role, 'COMPLETE_DEFECT') && item.status === 'IN_PROGRESS' ? (
        <button
          type="button"
          className="primary-button"
          onClick={() =>
            run(`/api/defects/${item.id}/complete`, 'POST', { expectedVersion: item.version })
          }
        >
          Исполнить
        </button>
      ) : null}
      {hasCapability(user.role, 'REOPEN_DEFECT') && item.status === 'COMPLETED' ? (
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            const reason = window.prompt('Причина возврата в работу');
            if (!reason) {
              return;
            }
            void run(`/api/defects/${item.id}/reopen`, 'POST', {
              expectedVersion: item.version,
              reason,
            });
          }}
        >
          Вернуть в работу
        </button>
      ) : null}
      {hasCapability(user.role, 'MANAGE_PROPOSALS') ? (
        <ProposalEditor
          item={item}
          onSave={(slot, body) => run(`/api/defects/${item.id}/proposals/${slot}`, 'PUT', body)}
        />
      ) : null}
      {toast ? (
        <p className="toast" role="status" aria-live="polite">
          {toast}
        </p>
      ) : null}
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
  if (!open) {
    return (
      <button type="button" className="ghost-button" onClick={() => setOpen(true)}>
        Изменить данные акта
      </button>
    );
  }
  return (
    <form
      className="toolbar"
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
      <label>
        Дата акта
        <input type="date" value={issuedOn} onChange={(event) => setIssuedOn(event.target.value)} />
      </label>
      <label>
        Документ
        <input
          value={signedDocumentRef}
          onChange={(event) => setSignedDocumentRef(event.target.value)}
        />
      </label>
      <button type="submit" className="primary-button">
        Сохранить
      </button>
    </form>
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
  if (!open) {
    return (
      <button type="button" className="ghost-button" onClick={() => setOpen(true)}>
        Добавить дефект
      </button>
    );
  }
  const firstType = lookups.data?.defectTypes[0]?.id ?? '';
  const firstEngineer = lookups.data?.responsibleEngineers[0]?.id ?? '';
  return (
    <form
      className="toolbar"
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
      <input name="location" aria-label="Помещение" placeholder="Помещение" required />
      <input name="claimDetails" aria-label="Описание" placeholder="Описание" required />
      <select name="defectTypeId" aria-label="Вид дефекта">
        {(lookups.data?.defectTypes ?? []).map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <button type="submit" className="primary-button">
        Добавить
      </button>
    </form>
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
  if (!canPlan && !canClaim && !canThird) {
    return null;
  }
  return (
    <form
      className="toolbar"
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
      }}
    >
      {canPlan ? (
        <label>
          Плановый срок
          <input name="plannedDeadline" type="date" defaultValue={item.plannedDeadline ?? ''} />
        </label>
      ) : null}
      {canClaim ? (
        <label>
          Срок претензии
          <input name="claimDeadline" type="date" defaultValue={item.claimDeadline ?? ''} />
        </label>
      ) : null}
      {canThird ? (
        <label>
          Срок третьей стороны
          <input
            name="thirdPartyDeadline"
            type="date"
            defaultValue={item.thirdPartyDeadline ?? ''}
          />
        </label>
      ) : null}
      <label>
        Причина
        <input name="reason" />
      </label>
      <button type="submit" className="ghost-button">
        Изменить сроки
      </button>
    </form>
  );
}

function ProposalEditor({
  item,
  onSave,
}: {
  item: ActDetailDefectItem;
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
  return (
    <form
      className="toolbar"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const slot = form.get('slot') as 'A' | 'B' | 'C';
        onSave(slot, {
          amount: form.get('amount'),
          alternativeContractorOrganizationId: form.get('organizationId'),
          expectedVersion: item.proposalA?.version,
        });
      }}
    >
      <label>
        Слот
        <select name="slot" defaultValue="A">
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="C">C</option>
        </select>
      </label>
      <label>
        Сумма
        <input name="amount" defaultValue={item.proposalA?.amount ?? '0.00'} required />
      </label>
      <label>
        Организация
        <select name="organizationId">
          {(lookups.data?.alternativeContractors ?? []).map((org) => (
            <option key={org.id} value={org.id}>
              {org.officialName}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="ghost-button">
        Сохранить предложение
      </button>
    </form>
  );
}

function HistoryPanel({ actId, onClose }: { actId: string; onClose: () => void }) {
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
  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <section
        className="dialog"
        role="dialog"
        aria-labelledby="history-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="history-title">История изменений</h2>
        {history.isLoading ? <p>Загрузка…</p> : null}
        {history.isError ? <p>Не удалось загрузить историю</p> : null}
        {(history.data?.items.length ?? 0) === 0 && !history.isLoading ? <p>Записей нет</p> : null}
        <ol className="timeline">
          {(history.data?.items ?? []).map((item) => (
            <li key={item.id} className="timeline__item">
              <strong>{AUDIT_ACTION_LABELS[item.action] ?? item.action}</strong>
              <p>
                {item.actorName ?? 'Система'} · {new Date(item.occurredAt).toLocaleString('ru-BY')}
              </p>
              {item.reason ? <p>Причина: {item.reason}</p> : null}
              <p>
                Было: {summarize(item.oldValue)} → Стало: {summarize(item.newValue)}
              </p>
            </li>
          ))}
        </ol>
        <button type="button" className="ghost-button" onClick={onClose}>
          Закрыть
        </button>
      </section>
    </div>
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
