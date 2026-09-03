import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors';
import {
  chatMessageSnippet,
  decodeChatCursor,
  dedupeMentionUserIds,
  encodeChatCursor,
  isChatMentionableRole,
  mentionRecipientIds,
  normalizeChatBody,
  notificationDestination,
  splitChatBody,
} from './chat';

describe('act chat domain', () => {
  it('trims and rejects empty or oversized bodies', () => {
    expect(normalizeChatBody('  Проверьте срок  ')).toBe('Проверьте срок');
    expect(() => normalizeChatBody('   ')).toThrow(ValidationError);
    expect(() => normalizeChatBody('')).toThrow(ValidationError);
    expect(() => normalizeChatBody(null)).toThrow(ValidationError);
    expect(normalizeChatBody('a'.repeat(4000))).toHaveLength(4000);
    expect(() => normalizeChatBody('a'.repeat(4001))).toThrow(/4000/);
  });

  it('deduplicates mention ids and skips self-mentions for notifications', () => {
    const author = '11111111-1111-4111-8111-111111111111';
    const other = '22222222-2222-4222-8222-222222222222';
    const ids = dedupeMentionUserIds([other, other, author, 'not-a-uuid', other]);
    expect(ids).toEqual([other, author]);
    expect(mentionRecipientIds(ids, author)).toEqual([other]);
  });

  it('does not treat a contractor role as mentionable', () => {
    expect(isChatMentionableRole('ADMIN')).toBe(true);
    expect(isChatMentionableRole('MANAGER')).toBe(true);
    expect(isChatMentionableRole('SGR_MANAGER')).toBe(true);
    expect(isChatMentionableRole('RESPONSIBLE_ENGINEER')).toBe(true);
    expect(isChatMentionableRole('CONTRACTOR_ENGINEER')).toBe(false);
  });

  it('keeps HTML as plain text segments', () => {
    const body = '<script>alert(1)</script> @Иван Петров смотрите';
    const segments = splitChatBody(body, [
      { userId: '33333333-3333-4333-8333-333333333333', fullName: 'Иван Петров' },
    ]);
    expect(segments[0]).toEqual({ kind: 'text', text: '<script>alert(1)</script> ' });
    expect(segments[1]).toEqual({
      kind: 'mention',
      text: '@Иван Петров',
      userId: '33333333-3333-4333-8333-333333333333',
    });
    expect(segments.some((item) => item.kind === 'text' && item.text.includes('<script>'))).toBe(
      true,
    );
  });

  it('encodes a stable keyset cursor', () => {
    const createdAt = new Date('2026-09-01T12:00:00.000Z');
    const id = '44444444-4444-4444-8444-444444444444';
    const encoded = encodeChatCursor(createdAt, id);
    expect(decodeChatCursor(encoded)).toEqual({ createdAt, id });
    expect(() => decodeChatCursor('bad')).toThrow(ValidationError);
  });

  it('builds a notification deep link to the discussion tab', () => {
    expect(
      notificationDestination({
        type: 'ACT_CHAT_MENTION',
        actId: '55555555-5555-4555-8555-555555555555',
        defectItemId: null,
      }),
    ).toBe('/acts/55555555-5555-4555-8555-555555555555?tab=discussion');
    expect(chatMessageSnippet('  один   два  '.padEnd(300, 'x')).endsWith('…')).toBe(true);
  });
});
