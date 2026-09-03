import type { UserRole, UserStatus } from '@sgr-registry/contracts';
import { ValidationError } from './errors';
import { normalizeRequiredText } from './text';

export const ACT_CHAT_MAX_BODY_LENGTH = 4000;
export const ACT_CHAT_DEFAULT_PAGE_SIZE = 30;
export const ACT_CHAT_MAX_PAGE_SIZE = 50;
export const ACT_CHAT_MENTION_CANDIDATE_LIMIT = 8;
export const ACT_CHAT_SNIPPET_LENGTH = 180;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CHAT_MENTIONABLE_ROLES: readonly UserRole[] = [
  'ADMIN',
  'MANAGER',
  'SGR_MANAGER',
  'RESPONSIBLE_ENGINEER',
];

export type ChatAuthorPublic = {
  id: string;
  fullName: string;
  role: UserRole;
  roleLabel?: string;
  status: UserStatus;
};

export type ChatBodySegment =
  { kind: 'text'; text: string } | { kind: 'mention'; text: string; userId: string };

export type ChatCursor = {
  createdAt: Date;
  id: string;
};

export function normalizeChatBody(value: unknown): string {
  return normalizeRequiredText(value, 'body', ACT_CHAT_MAX_BODY_LENGTH);
}

export function isChatMentionableRole(role: UserRole): boolean {
  return (CHAT_MENTIONABLE_ROLES as readonly string[]).includes(role);
}

export function dedupeMentionUserIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
      continue;
    }
    const id = raw.toLowerCase();
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(raw);
  }
  return result;
}

export function mentionRecipientIds(mentionUserIds: readonly string[], authorId: string): string[] {
  return mentionUserIds.filter((id) => id !== authorId);
}

export function chatMessageSnippet(body: string, maxLength = ACT_CHAT_SNIPPET_LENGTH): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength).trimEnd()}…`;
}

export function encodeChatCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}_${id}`;
}

export function decodeChatCursor(value: string | undefined): ChatCursor | null {
  if (!value) {
    return null;
  }
  const separator = value.lastIndexOf('_');
  if (separator <= 0 || separator === value.length - 1) {
    throw new ValidationError('cursor', 'Некорректный курсор');
  }
  const createdAt = new Date(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !UUID_PATTERN.test(id)) {
    throw new ValidationError('cursor', 'Некорректный курсор');
  }
  return { createdAt, id };
}

export function splitChatBody(
  body: string,
  mentions: Array<{ userId: string; fullName: string }>,
): ChatBodySegment[] {
  if (mentions.length === 0) {
    return body.length > 0 ? [{ kind: 'text', text: body }] : [];
  }
  const unique = new Map<string, { userId: string; fullName: string; token: string }>();
  for (const mention of mentions) {
    const token = `@${mention.fullName}`;
    const existing = unique.get(token);
    if (!existing || mention.fullName.length > existing.fullName.length) {
      unique.set(token, { ...mention, token });
    }
  }
  const tokens = [...unique.values()].sort((left, right) => right.token.length - left.token.length);
  const segments: ChatBodySegment[] = [];
  let remaining = body;
  while (remaining.length > 0) {
    let nearest = -1;
    let matched: { userId: string; token: string } | null = null;
    for (const item of tokens) {
      const index = remaining.indexOf(item.token);
      if (index >= 0 && (nearest < 0 || index < nearest)) {
        nearest = index;
        matched = { userId: item.userId, token: item.token };
      }
    }
    if (!matched || nearest < 0) {
      segments.push({ kind: 'text', text: remaining });
      break;
    }
    if (nearest > 0) {
      segments.push({ kind: 'text', text: remaining.slice(0, nearest) });
    }
    segments.push({ kind: 'mention', text: matched.token, userId: matched.userId });
    remaining = remaining.slice(nearest + matched.token.length);
  }
  return segments;
}

export function chatMentionOccurrenceKey(messageId: string, userId: string): string[] {
  return ['ACT_CHAT_MENTION', messageId, userId];
}

export function notificationDestination(item: {
  type: string;
  actId: string | null;
  defectItemId: string | null;
  organizationId?: string | null;
}): string | null {
  if (item.type === 'ORGANIZATION_DETAILS_INCOMPLETE' && item.organizationId) {
    return `/reference-data?tab=organizations&id=${item.organizationId}`;
  }
  if (!item.actId) {
    return null;
  }
  if (item.type === 'ACT_CHAT_MENTION') {
    return `/acts/${item.actId}?tab=discussion`;
  }
  if (item.defectItemId) {
    return `/acts/${item.actId}?defect=${item.defectItemId}`;
  }
  return `/acts/${item.actId}`;
}
