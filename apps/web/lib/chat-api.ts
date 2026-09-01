import type {
  ActChatListResponse,
  ActChatMentionCandidatesResponse,
  ActChatMessageDto,
} from '@sgr-registry/contracts';
import { commandFetch } from './command-api';

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status}`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

export function fetchActChat(
  actId: string,
  query: { before?: string; after?: string; limit?: number } = {},
): Promise<ActChatListResponse> {
  const params = new URLSearchParams();
  if (query.before) params.set('before', query.before);
  if (query.after) params.set('after', query.after);
  if (query.limit) params.set('limit', String(query.limit));
  const suffix = params.toString();
  return getJson(`/api/acts/${actId}/chat${suffix ? `?${suffix}` : ''}`);
}

export function fetchActChatMentionCandidates(
  actId: string,
  q: string,
): Promise<ActChatMentionCandidatesResponse> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  const suffix = params.toString();
  return getJson(`/api/acts/${actId}/chat/mention-candidates${suffix ? `?${suffix}` : ''}`);
}

export function postActChatMessage(
  actId: string,
  csrfToken: string,
  input: { body: string; mentionedUserIds: string[]; clientMessageId: string },
): Promise<ActChatMessageDto> {
  return commandFetch(`/api/acts/${actId}/chat`, {
    method: 'POST',
    csrfToken,
    body: input,
  });
}
