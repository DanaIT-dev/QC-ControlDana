'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ActChatMentionCandidateDto, ActChatMessageDto } from '@sgr-registry/contracts';
import { splitChatBody } from '@sgr-registry/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/lib/command-api';
import { fetchActChat, fetchActChatMentionCandidates, postActChatMessage } from '@/lib/chat-api';
import { queryKeys } from '@/lib/query-keys';
import { formatTimestamp } from '@/lib/registry-url';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const POLL_MS = 8_000;

function mentionTrigger(text: string, caret: number): { start: number; query: string } | null {
  const until = text.slice(0, caret);
  const match = until.match(/(^|[\s])@([^\s@]*)$/);
  if (!match) {
    return null;
  }
  const query = match[2] ?? '';
  return { start: until.length - query.length - 1, query };
}

function mergeMessages(current: ActChatMessageDto[], incoming: ActChatMessageDto[]) {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    map.set(item.id, item);
  }
  return [...map.values()].sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return left.id.localeCompare(right.id);
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
}

export function ActDiscussion({
  actId,
  csrfToken,
  canPost = true,
}: {
  actId: string;
  csrfToken: string;
  canPost?: boolean;
}) {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ActChatMessageDto[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [newestCursor, setNewestCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [mentions, setMentions] = useState<Array<{ userId: string; fullName: string }>>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [openMention, setOpenMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionListRef = useRef<HTMLUListElement>(null);
  const newestRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const clientMessageIdRef = useRef(crypto.randomUUID());

  const initial = useQuery({
    queryKey: queryKeys.actChat(actId),
    queryFn: () => fetchActChat(actId),
    retry: false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!initial.data) {
      return;
    }
    setMessages((current) => mergeMessages(current, initial.data.items));
    setHasOlder(initial.data.hasOlder);
    setOlderCursor(initial.data.olderCursor);
    setNewestCursor(initial.data.newestCursor);
    newestRef.current = initial.data.newestCursor;
  }, [initial.data]);

  useEffect(() => {
    function sync() {
      setPageVisible(document.visibilityState === 'visible');
    }
    function onFocus() {
      setPageVisible(true);
    }
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const poll = useCallback(async () => {
    if (!pageVisible) {
      return;
    }
    const after = newestRef.current;
    const page = await fetchActChat(actId, after ? { after } : {});
    setMessages((current) => mergeMessages(current, page.items));
    if (page.newestCursor) {
      setNewestCursor(page.newestCursor);
      newestRef.current = page.newestCursor;
    }
    if (!after) {
      setHasOlder(page.hasOlder);
      setOlderCursor(page.olderCursor);
    }
  }, [actId, pageVisible]);

  useEffect(() => {
    if (!pageVisible) {
      return;
    }
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [pageVisible, poll]);

  const candidatesQuery = useQuery({
    queryKey: queryKeys.actChatMentions(actId, mentionQuery),
    queryFn: () => fetchActChatMentionCandidates(actId, mentionQuery),
    enabled: openMention,
    staleTime: 15_000,
  });
  const candidates = candidatesQuery.data?.items ?? [];

  useEffect(() => {
    if (!openMention) {
      return;
    }
    mentionListRef.current?.scrollIntoView({ block: 'end', inline: 'nearest' });
  }, [openMention, candidates.length]);

  const applyDraft = (value: string, caret: number) => {
    setDraft(value);
    const trigger = mentionTrigger(value, caret);
    if (trigger) {
      setOpenMention(true);
      setMentionQuery(trigger.query);
      setMentionStart(trigger.start);
      setHighlight(0);
    } else {
      setOpenMention(false);
      setMentionQuery('');
    }
  };

  const insertMention = (candidate: ActChatMentionCandidateDto) => {
    const caret = textareaRef.current?.selectionStart ?? draft.length;
    const trigger = mentionTrigger(draft, caret);
    const start = trigger?.start ?? mentionStart;
    const before = draft.slice(0, start);
    const after = draft.slice(caret);
    const inserted = `@${candidate.fullName} `;
    const next = `${before}${inserted}${after}`;
    setDraft(next);
    setMentions((current) =>
      current.some((item) => item.userId === candidate.id)
        ? current
        : [...current, { userId: candidate.id, fullName: candidate.fullName }],
    );
    setOpenMention(false);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) {
        return;
      }
      node.focus();
      const position = before.length + inserted.length;
      node.setSelectionRange(position, position);
    });
  };

  async function send() {
    const body = draft.trim();
    if (!body || sending || inFlightRef.current) {
      return;
    }
    const mentionedUserIds = mentions
      .filter((item) => body.includes(`@${item.fullName}`))
      .map((item) => item.userId);
    inFlightRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      const created = await postActChatMessage(actId, csrfToken, {
        body,
        mentionedUserIds,
        clientMessageId: clientMessageIdRef.current,
      });
      setMessages((current) => mergeMessages(current, [created]));
      setNewestCursor(created.createdAt ? `${created.createdAt}_${created.id}` : newestCursor);
      newestRef.current = `${new Date(created.createdAt).toISOString()}_${created.id}`;
      setDraft('');
      setMentions([]);
      clientMessageIdRef.current = crypto.randomUUID();
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    } catch (error) {
      setSendError(error instanceof ApiError ? error.message : 'Не удалось отправить сообщение');
    } finally {
      setSending(false);
      inFlightRef.current = false;
    }
  }

  async function loadOlder() {
    if (!olderCursor || loadingOlder) {
      return;
    }
    setLoadingOlder(true);
    try {
      const page = await fetchActChat(actId, { before: olderCursor });
      setMessages((current) => mergeMessages(page.items, current));
      setHasOlder(page.hasOlder);
      setOlderCursor(page.olderCursor);
    } finally {
      setLoadingOlder(false);
    }
  }

  const highlighted = useMemo(() => candidates[highlight] ?? null, [candidates, highlight]);

  return (
    <Card id="act-discussion" className="min-w-0 max-w-full overflow-x-hidden shadow-none">
      <CardHeader>
        <CardTitle className="text-lg">Обсуждение</CardTitle>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4">
        {initial.isLoading ? <Skeleton className="h-40 w-full" /> : null}
        {initial.isError ? (
          <div className="grid gap-2">
            <p className="text-sm text-error-foreground">Не удалось загрузить обсуждение</p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-fit"
              onClick={() => void initial.refetch()}
            >
              Повторить
            </Button>
          </div>
        ) : null}
        {hasOlder ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full sm:w-fit"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? 'Загрузка…' : 'Показать предыдущие сообщения'}
          </Button>
        ) : null}
        {!initial.isLoading && !initial.isError && messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">Сообщений пока нет</p>
        ) : null}
        <ul
          className="grid min-w-0 max-w-full gap-3 overflow-x-hidden"
          aria-live="polite"
          data-slot="act-chat-thread"
        >
          {messages.map((message) => (
            <li key={message.id} className="grid min-w-0 max-w-full gap-1 overflow-hidden">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                <span className="min-w-0 font-medium break-words">{message.author.fullName}</span>
                <span className="text-xs text-muted-foreground">{message.author.roleLabel}</span>
                <time className="text-xs text-muted-foreground" dateTime={message.createdAt}>
                  {formatTimestamp(message.createdAt)}
                </time>
              </div>
              <p className="max-w-full overflow-hidden text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {splitChatBody(message.body, message.mentions).map((segment, index) =>
                  segment.kind === 'mention' ? (
                    <span
                      key={`${message.id}-m-${index}`}
                      className="rounded-sm bg-brand/10 px-0.5 font-medium text-brand"
                    >
                      {segment.text}
                    </span>
                  ) : (
                    <span key={`${message.id}-t-${index}`}>{segment.text}</span>
                  ),
                )}
              </p>
            </li>
          ))}
        </ul>
        {canPost ? (
          <form
            className="grid min-w-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Label htmlFor="act-chat-draft">Сообщение</Label>
            <Textarea
              id="act-chat-draft"
              ref={textareaRef}
              value={draft}
              disabled={sending}
              rows={3}
              className="min-h-20 max-h-48 overflow-y-auto"
              placeholder="Напишите сообщение. @ — чтобы упомянуть коллегу"
              onChange={(event) => applyDraft(event.target.value, event.target.selectionStart)}
              onKeyDown={(event) => {
                if (openMention && candidates.length > 0) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setHighlight((index) => (index + 1) % candidates.length);
                    return;
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setHighlight((index) => (index - 1 + candidates.length) % candidates.length);
                    return;
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (highlighted) {
                      insertMention(highlighted);
                    }
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setOpenMention(false);
                    return;
                  }
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {openMention ? (
              <ul
                ref={mentionListRef}
                role="listbox"
                aria-label="Сотрудники"
                className="max-h-[min(12rem,40vh)] w-full min-w-0 max-w-[min(100%,calc(100vw-2rem))] scroll-mb-4 overflow-y-auto overflow-x-hidden rounded-lg border border-border bg-background shadow-md"
              >
                {candidatesQuery.isLoading ? (
                  <li className="px-3 py-2 text-sm text-muted-foreground">Поиск…</li>
                ) : null}
                {candidatesQuery.isError ? (
                  <li className="px-3 py-2 text-sm text-error-foreground">
                    Не удалось загрузить список
                  </li>
                ) : null}
                {!candidatesQuery.isLoading && candidates.length === 0 ? (
                  <li className="px-3 py-2 text-sm text-muted-foreground">Никого не найдено</li>
                ) : null}
                {candidates.map((candidate, index) => (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === highlight}
                      className={cn(
                        'flex min-h-11 w-full min-w-0 items-center justify-between gap-2 px-3 py-2 text-left text-sm',
                        index === highlight && 'bg-muted',
                      )}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertMention(candidate)}
                    >
                      <span className="min-w-0 break-words">{candidate.fullName}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {candidate.roleLabel}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {sendError ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-error-foreground">{sendError}</p>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => void send()}
                >
                  Повторить
                </Button>
              </div>
            ) : null}
            <Button
              type="submit"
              className="min-h-11 w-full sm:w-fit"
              disabled={sending || draft.trim().length === 0}
            >
              {sending ? 'Отправка…' : 'Отправить'}
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
