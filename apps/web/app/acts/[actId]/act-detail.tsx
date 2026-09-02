'use client';

import { useQuery } from '@tanstack/react-query';
import {
  canViewProposalGroupBC,
  canViewHistory,
  canViewActChat,
  canUploadCategory,
  hasCapability,
} from '@sgr-registry/domain';
import type { SafeUserProfile } from '@sgr-registry/contracts';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DeadlineBadge, StatusBadge } from '@/components/status-badge';
import { ErrorState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UserAvatar } from '@/components/user-avatar';
import { fetchActDetail } from '../../../lib/registry-api';
import { formatCalendarDate, formatTimestamp, isSafeDocumentHref } from '../../../lib/registry-url';
import { queryKeys } from '../../../lib/query-keys';
import { ActHistory, ActOperations } from './act-operations';
import { ActDiscussion } from './act-discussion';
import { AttachmentsPanel } from '@/components/attachments-panel';
import { ProposalValue, proposalSlotOf } from '@/components/proposal-value';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export function ActDetailView({ actId, user }: { actId: string; user: SafeUserProfile }) {
  const params = useSearchParams();
  const highlighted = params.get('defect');
  const requestedTab = params.get('tab');
  const backQuery = (() => {
    const copy = new URLSearchParams(params.toString());
    copy.delete('defect');
    copy.delete('tab');
    const encoded = copy.toString();
    return encoded ? `/registry?${encoded}` : '/registry';
  })();
  const detailQuery = useQuery({
    queryKey: queryKeys.act(actId),
    queryFn: () => fetchActDetail(actId),
    retry: false,
  });
  const showChat = canViewActChat(user.role);
  const [tab, setTab] = useState(() =>
    requestedTab === 'discussion' && showChat ? 'discussion' : 'defects',
  );

  useEffect(() => {
    if (requestedTab === 'discussion' && showChat) {
      setTab('discussion');
    }
  }, [requestedTab, showChat]);

  useEffect(() => {
    if (tab !== 'discussion' || !detailQuery.data) {
      return;
    }
    document.getElementById('act-discussion')?.scrollIntoView({ block: 'start' });
  }, [tab, detailQuery.data?.id]);

  if (detailQuery.isLoading) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <ErrorState title="Запись не найдена" description="Документ недоступен или не существует." />
    );
  }

  const act = detailQuery.data;
  const showBC = canViewProposalGroupBC(user.role);
  const showHistory = canViewHistory(user.role);

  return (
    <article className="act-detail grid min-w-0 max-w-full gap-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href={backQuery}>Реестр</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Акт {act.officialNumber}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <Button asChild variant="ghost" className="-ml-2 mb-2">
            <Link href={backQuery}>
              <ArrowLeft data-icon="inline-start" />
              Назад к реестру
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">Акт {act.officialNumber}</h1>
            <Badge variant="secondary">{act.formLabel}</Badge>
            <StatusBadge status={act.status} label={act.statusLabel} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {act.objectName} · {act.customerName}
          </p>
          {act.status === 'NEW' ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Работа по акту ещё не начата. Нажмите «Взять в работу», чтобы перевести акт в статус
              «В работе».
            </p>
          ) : null}
        </div>
        <ActOperations act={act} user={user} />
      </div>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-lg">Данные акта</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Meta label="Объект" value={act.objectName} />
          <Meta label="Адрес" value={act.objectAddress} />
          <Meta label="Заказчик" value={act.customerName} />
          <Meta label="Дата ввода" value={formatCalendarDate(act.commissionedAt)} />
          <Meta label="Окончание гарантии" value={formatCalendarDate(act.warrantyEndsAt)} />
          <Meta label="Создан" value={formatTimestamp(act.createdAt)} />
          {act.startedAt ? (
            <Meta
              label="Взят в работу"
              value={`${act.startedBy?.fullName ?? '—'} · ${formatTimestamp(act.startedAt)}`}
            />
          ) : null}
          {act.cancelledAt ? (
            <Meta
              label="Аннулирован"
              value={`${formatTimestamp(act.cancelledAt)}${act.cancellationReason ? ` · ${act.cancellationReason}` : ''}`}
            />
          ) : null}
          {isSafeDocumentHref(act.signedDocumentRef) ? (
            <div className="grid gap-1">
              <span className="text-[13px] text-muted-foreground">Документ</span>
              <a
                className="text-brand hover:underline"
                href={act.signedDocumentRef}
                target="_blank"
                rel="noreferrer"
              >
                Документ
              </a>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <AttachmentsPanel
        title="Вложения акта"
        listPath={`/api/acts/${act.id}/attachments`}
        uploadPath={`/api/acts/${act.id}/attachments`}
        categories={['ACT_DOCUMENT', 'ACT_SCAN', 'OTHER']}
        canUpload={canUploadCategory(user.role, 'ACT', 'ACT_DOCUMENT')}
        csrfToken={user.csrfToken}
      />
      <Tabs value={tab} onValueChange={setTab} className="min-w-0 max-w-full">
        <TabsList className="h-auto min-h-8 w-full max-w-full flex-wrap justify-start">
          <TabsTrigger value="defects">Дефекты</TabsTrigger>
          {showChat ? <TabsTrigger value="discussion">Обсуждение</TabsTrigger> : null}
          {showHistory ? <TabsTrigger value="history">История изменений</TabsTrigger> : null}
        </TabsList>
        <TabsContent
          value="defects"
          className="mt-4 grid flex-none gap-3 data-[state=inactive]:hidden"
        >
          {act.defectItems.map((item) => (
            <Card
              key={item.id}
              className={cn(
                'act-item shadow-none',
                item.id === highlighted && 'act-item--current ring-2 ring-ring',
              )}
            >
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
                <div className="grid gap-1">
                  <CardTitle className="text-base">{item.location}</CardTitle>
                  <p className="text-sm text-muted-foreground">{item.defectTypeName}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <StatusBadge status={item.status} label={item.statusLabel} />
                  <DeadlineBadge state={item.deadlineState} label={item.deadlineStateLabel} />
                </div>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Meta label="Плановый срок" value={formatCalendarDate(item.plannedDeadline)} />
                  <Meta label="Срок по претензии" value={formatCalendarDate(item.claimDeadline)} />
                  <Meta
                    label="Эффективный срок"
                    value={`${formatCalendarDate(item.effectiveDeadline)} · ${item.deadlineStateLabel}`}
                  />
                  <Meta
                    label="Срок третьей стороны"
                    value={formatCalendarDate(item.thirdPartyDeadline)}
                  />
                  <Meta label="Дата готовности" value={formatTimestamp(item.readyAt)} />
                  <Meta
                    label="Предложение А"
                    value={<ProposalValue proposal={item.proposalA} layout="block" />}
                  />
                  {showBC ? (
                    <>
                      <Meta
                        label="Предложение B"
                        value={
                          <ProposalValue
                            proposal={proposalSlotOf(item.proposalsBC, 'B')}
                            layout="block"
                          />
                        }
                      />
                      <Meta
                        label="Предложение C"
                        value={
                          <ProposalValue
                            proposal={proposalSlotOf(item.proposalsBC, 'C')}
                            layout="block"
                          />
                        }
                      />
                    </>
                  ) : null}
                </div>
                {item.notes ? <p className="text-sm">Примечания: {item.notes}</p> : null}
                <AttachmentsPanel
                  title="Файлы и фотографии"
                  listPath={`/api/defects/${item.id}/attachments`}
                  uploadPath={`/api/defects/${item.id}/attachments`}
                  categories={
                    user.role === 'CONTRACTOR_ENGINEER'
                      ? ['THIRD_PARTY_DOCUMENT']
                      : user.role === 'RESPONSIBLE_ENGINEER'
                        ? ['DEFECT_PHOTO', 'OTHER']
                        : ['DEFECT_PHOTO', 'CLAIM_DOCUMENT', 'THIRD_PARTY_DOCUMENT', 'OTHER']
                  }
                  canUpload={(
                    ['DEFECT_PHOTO', 'CLAIM_DOCUMENT', 'THIRD_PARTY_DOCUMENT', 'OTHER'] as const
                  ).some((category) => canUploadCategory(user.role, 'DEFECT_ITEM', category))}
                  csrfToken={user.csrfToken}
                  compact
                />
                {item.proposalA?.id ? (
                  <AttachmentsPanel
                    title="Документы предложения A"
                    listPath={`/api/proposals/${item.proposalA.id}/attachments`}
                    uploadPath={`/api/proposals/${item.proposalA.id}/attachments`}
                    categories={['PROPOSAL_DOCUMENT']}
                    canUpload={canUploadCategory(user.role, 'PROPOSAL', 'PROPOSAL_DOCUMENT')}
                    csrfToken={user.csrfToken}
                    compact
                  />
                ) : null}
                {showBC
                  ? item.proposalsBC?.map((proposal) =>
                      proposal.id ? (
                        <AttachmentsPanel
                          key={proposal.id}
                          title={`Документы предложения ${proposal.slot}`}
                          listPath={`/api/proposals/${proposal.id}/attachments`}
                          uploadPath={`/api/proposals/${proposal.id}/attachments`}
                          categories={['PROPOSAL_DOCUMENT']}
                          canUpload={canUploadCategory(user.role, 'PROPOSAL', 'PROPOSAL_DOCUMENT')}
                          csrfToken={user.csrfToken}
                          compact
                        />
                      ) : null,
                    )
                  : null}
                <div className="flex flex-wrap gap-2">
                  {item.responsibleEngineers.map((entry) => (
                    <Badge key={entry.id} variant="secondary" className="gap-1.5 pr-2">
                      <UserAvatar name={entry.fullName} size="sm" />
                      {entry.fullName}
                    </Badge>
                  ))}
                  {item.liableOrganizations.map((entry) => (
                    <Badge key={entry.id} variant="outline">
                      {entry.name}
                    </Badge>
                  ))}
                </div>
                <ActOperations act={act} item={item} user={user} />
              </CardContent>
            </Card>
          ))}
        </TabsContent>
        {showChat ? (
          <TabsContent
            value="discussion"
            className="mt-4 min-w-0 flex-none data-[state=inactive]:hidden"
          >
            {tab === 'discussion' ? (
              <ActDiscussion
                actId={act.id}
                csrfToken={user.csrfToken}
                canPost={hasCapability(user.role, 'VIEW_ACT_CHAT')}
              />
            ) : null}
          </TabsContent>
        ) : null}
        {showHistory ? (
          <TabsContent value="history" className="mt-4 flex-none data-[state=inactive]:hidden">
            <ActHistory actId={act.id} />
          </TabsContent>
        ) : null}
      </Tabs>
    </article>
  );
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-sm">{value ?? '—'}</span>
    </div>
  );
}
