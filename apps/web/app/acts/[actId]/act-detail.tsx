'use client';

import { useQuery } from '@tanstack/react-query';
import { canViewProposalGroupBC } from '@sgr-registry/domain';
import type { SafeUserProfile } from '@sgr-registry/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { fetchActDetail } from '../../../lib/registry-api';
import { formatCalendarDate, formatTimestamp, isSafeDocumentHref } from '../../../lib/registry-url';
import { ActOperations } from './act-operations';

export function ActDetailView({ actId, user }: { actId: string; user: SafeUserProfile }) {
  const params = useSearchParams();
  const highlighted = params.get('defect');
  const backQuery = (() => {
    const copy = new URLSearchParams(params.toString());
    copy.delete('defect');
    const encoded = copy.toString();
    return encoded ? `/registry?${encoded}` : '/registry';
  })();
  const detailQuery = useQuery({
    queryKey: ['act', actId],
    queryFn: () => fetchActDetail(actId),
    retry: false,
  });

  if (detailQuery.isLoading) {
    return (
      <section className="panel">
        <p className="lead">Загрузка карточки акта…</p>
      </section>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <section className="panel">
        <h2>Запись не найдена</h2>
        <p className="lead">Документ недоступен или не существует.</p>
        <Link className="text-link" href="/registry">
          Назад к реестру
        </Link>
      </section>
    );
  }

  const act = detailQuery.data;
  const showBC = canViewProposalGroupBC(user.role);

  return (
    <article className="act-detail">
      <p>
        <Link className="text-link" href={backQuery}>
          Назад к реестру
        </Link>
      </p>
      <header className="panel">
        <p className="act-kicker">
          {act.formLabel} · {act.officialNumber}
        </p>
        <h1>Акт {act.officialNumber}</h1>
        <p>
          Статус акта: <strong>{act.statusLabel}</strong>
        </p>
        <p>
          {act.objectName}
          <br />
          {act.objectAddress}
        </p>
        <p>Заказчик: {act.customerName}</p>
        <p>Дата ввода: {formatCalendarDate(act.commissionedAt)}</p>
        <p>Окончание гарантии: {formatCalendarDate(act.warrantyEndsAt)}</p>
        <p>Создан: {formatTimestamp(act.createdAt)}</p>
        {act.cancelledAt ? (
          <p>
            Аннулирован: {formatTimestamp(act.cancelledAt)}
            {act.cancellationReason ? ` · ${act.cancellationReason}` : ''}
          </p>
        ) : null}
        {isSafeDocumentHref(act.signedDocumentRef) ? (
          <p>
            <a className="text-link" href={act.signedDocumentRef} target="_blank" rel="noreferrer">
              Документ
            </a>
          </p>
        ) : null}
        <ActOperations act={act} user={user} />
      </header>
      <ol className="act-items">
        {act.defectItems.map((item) => (
          <li
            key={item.id}
            className={
              item.id === highlighted ? 'panel act-item act-item--current' : 'panel act-item'
            }
          >
            <h2>{item.location}</h2>
            <p>{item.defectTypeName}</p>
            <p>
              Статус строки: <strong>{item.statusLabel}</strong>
            </p>
            <p>
              Ответственные:{' '}
              {item.responsibleEngineers.map((entry) => entry.fullName).join(', ') || '—'}
            </p>
            <p>
              Виновные организации:{' '}
              {item.liableOrganizations.map((entry) => entry.name).join(', ') || '—'}
            </p>
            <p>Плановый срок: {formatCalendarDate(item.plannedDeadline)}</p>
            <p>Срок по претензии: {formatCalendarDate(item.claimDeadline)}</p>
            <p>
              Эффективный срок: {formatCalendarDate(item.effectiveDeadline)} ·{' '}
              {item.deadlineStateLabel}
            </p>
            <p>Срок третьей стороны: {formatCalendarDate(item.thirdPartyDeadline)}</p>
            <p>Дата готовности: {formatTimestamp(item.readyAt)}</p>
            {item.notes ? <p>Примечания: {item.notes}</p> : null}
            <p>
              Предложение А:{' '}
              {item.proposalA ? `${item.proposalA.amount} ${item.proposalA.currency}` : '—'}
            </p>
            {showBC ? (
              <p>
                Предложения B/C:{' '}
                {item.proposalsBC?.length
                  ? item.proposalsBC
                      .map(
                        (proposal) => `${proposal.slot}: ${proposal.amount} ${proposal.currency}`,
                      )
                      .join('; ')
                  : '—'}
              </p>
            ) : null}
            <ActOperations act={act} item={item} user={user} />
          </li>
        ))}
      </ol>
    </article>
  );
}
