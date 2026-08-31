import { describe, expect, it } from 'vitest';
import { calendarDateToUtcNoon } from './deadline';
import { assertSafeHeaderValue, escapeHtml, renderNotificationEmail } from './email-content';
import {
  buildOccurrenceKey,
  containsCommercialProposalFields,
  parseNotificationListQuery,
  parseSlaListQuery,
  recipientsForDeadlineAlert,
  shapeUnreadCount,
  suppressActorRecipients,
  uniqueRecipientIds,
} from './notifications';
import {
  defaultNotificationSettings,
  parseDailyEvaluationTime,
  validateNotificationSettings,
} from './notification-settings';
import {
  emailJobId,
  emailMessageId,
  exponentialBackoffMs,
  classifySmtpError,
  isTerminalAttempt,
  outboxJobId,
  redactTransportSecrets,
  slaCatchUpJobId,
} from './outbox';
import {
  nextClockCycle,
  overdueDaysOf,
  reachedEscalationThresholds,
  shouldBumpGeneralCycle,
  slaStateOf,
} from './sla';

const today = new Date('2026-08-26T12:00:00.000Z');

describe('SLA clocks', () => {
  it('uses Europe/Minsk business date', () => {
    expect(
      slaStateOf({
        status: 'IN_PROGRESS',
        deadline: calendarDateToUtcNoon('2026-08-27'),
        warningDays: 3,
        now: new Date('2026-08-26T21:30:00.000Z'),
      }),
    ).toBe('DUE_TODAY');
  });

  it('classifies warning boundary, due today and overdue thresholds', () => {
    expect(
      slaStateOf({
        status: 'IN_PROGRESS',
        deadline: calendarDateToUtcNoon('2026-08-29'),
        warningDays: 3,
        now: today,
      }),
    ).toBe('WARNING');
    expect(
      slaStateOf({
        status: 'IN_PROGRESS',
        deadline: calendarDateToUtcNoon('2026-08-26'),
        warningDays: 3,
        now: today,
      }),
    ).toBe('DUE_TODAY');
    expect(
      slaStateOf({
        status: 'IN_PROGRESS',
        deadline: calendarDateToUtcNoon('2026-08-25'),
        warningDays: 3,
        now: today,
      }),
    ).toBe('OVERDUE');
    expect(overdueDaysOf({ deadline: calendarDateToUtcNoon('2026-08-26'), now: today })).toBe(0);
    expect(overdueDaysOf({ deadline: calendarDateToUtcNoon('2026-08-23'), now: today })).toBe(3);
    expect(overdueDaysOf({ deadline: calendarDateToUtcNoon('2026-08-19'), now: today })).toBe(7);
    expect(overdueDaysOf({ deadline: calendarDateToUtcNoon('2026-08-12'), now: today })).toBe(14);
    expect(reachedEscalationThresholds(14)).toEqual([0, 3, 7, 14]);
  });

  it('stops notifications when completed and bumps cycle on reopen', () => {
    expect(
      slaStateOf({
        status: 'COMPLETED',
        deadline: calendarDateToUtcNoon('2026-08-01'),
        warningDays: 3,
        now: today,
      }),
    ).toBe('COMPLETED');
    expect(nextClockCycle({ previousCycle: 2, bump: true })).toBe(3);
  });

  it('keeps THIRD_PARTY independent of GENERAL claim precedence', () => {
    expect(
      shouldBumpGeneralCycle({
        previousClaim: calendarDateToUtcNoon('2026-09-01'),
        previousPlanned: calendarDateToUtcNoon('2026-08-01'),
        nextClaim: calendarDateToUtcNoon('2026-09-01'),
        nextPlanned: calendarDateToUtcNoon('2026-08-15'),
      }),
    ).toBe(false);
    expect(
      shouldBumpGeneralCycle({
        previousClaim: calendarDateToUtcNoon('2026-09-01'),
        previousPlanned: calendarDateToUtcNoon('2026-08-01'),
        nextClaim: calendarDateToUtcNoon('2026-09-10'),
        nextPlanned: calendarDateToUtcNoon('2026-08-01'),
      }),
    ).toBe(true);
  });
});

describe('notification projection', () => {
  it('builds deterministic occurrence keys and deduplicates recipients', () => {
    expect(buildOccurrenceKey(['SLA_OVERDUE', 'GENERAL', 'd1', 2, 3, 'u1'])).toBe(
      'SLA_OVERDUE:GENERAL:d1:2:3:u1',
    );
    expect(uniqueRecipientIds(['b', 'a', 'a'])).toEqual(['a', 'b']);
  });

  it('builds the role recipient matrix and excludes archived/actor as specified', () => {
    expect(
      recipientsForDeadlineAlert({
        kind: 'GENERAL',
        threshold: 0,
        assignedResponsibleIds: ['resp'],
        contractorIds: ['con'],
        sgrManagerIds: ['mgr'],
        adminIds: ['adm'],
      }),
    ).toEqual(['mgr', 'resp']);
    expect(
      recipientsForDeadlineAlert({
        kind: 'THIRD_PARTY',
        threshold: 7,
        assignedResponsibleIds: ['resp'],
        contractorIds: ['con'],
        sgrManagerIds: ['mgr'],
        adminIds: ['adm'],
      }),
    ).toEqual(['adm', 'con', 'mgr']);
    expect(suppressActorRecipients(['actor', 'other'], 'actor', { automatic: false })).toEqual([
      'other',
    ]);
    expect(suppressActorRecipients(['actor', 'other'], 'actor', { automatic: true })).toEqual([
      'actor',
      'other',
    ]);
  });

  it('escapes HTML, rejects CRLF, validates settings and backoff', () => {
    expect(escapeHtml('<script>"x"</script>')).toBe('&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
    expect(() => assertSafeHeaderValue('bad\r\nBcc: a@b.c')).toThrow();
    const email = renderNotificationEmail({
      title: 'Срок сегодня',
      body: 'Дефект <b>x</b>',
      actUrl: 'https://app.example/acts/1',
    });
    expect(email.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(email.html).not.toContain('<b>x</b>');
    expect(validateNotificationSettings(defaultNotificationSettings()).escalationDays[0]).toBe(0);
    expect(parseDailyEvaluationTime('08:00')).toBe(480);
    expect(exponentialBackoffMs(1)).toBe(30_000);
    expect(isTerminalAttempt(8)).toBe(true);
    expect(outboxJobId('a-b')).toBe('outbox-a-b');
    expect(emailJobId('a-b')).toBe('email-a-b');
    expect(slaCatchUpJobId('2026-08-28')).toBe('sla-2026-08-28');
    expect(outboxJobId('a-b')).not.toContain(':');
    expect(emailJobId('a-b')).not.toContain(':');
    expect(slaCatchUpJobId('2026-08-28')).not.toContain(':');
    expect(emailMessageId('11111111-1111-1111-1111-111111111111', 'sgr-registry@localhost')).toBe(
      '11111111-1111-1111-1111-111111111111@localhost',
    );
    expect(emailMessageId('11111111-1111-1111-1111-111111111111', 'sgr-registry@localhost')).toBe(
      emailMessageId('11111111-1111-1111-1111-111111111111', 'noreply@localhost'),
    );
    expect(classifySmtpError({ responseCode: 450 }).code).toBe('SMTP_4XX');
    expect(classifySmtpError({ responseCode: 450 }).retryable).toBe(true);
    expect(classifySmtpError({ responseCode: 550 }).code).toBe('SMTP_5XX');
    expect(classifySmtpError({ responseCode: 550 }).retryable).toBe(false);
    expect(classifySmtpError({ code: 'ECONNREFUSED' }).code).toBe('SMTP_CONNECTION');
    expect(classifySmtpError({ code: 'ETIMEDOUT' }).code).toBe('SMTP_TIMEOUT');
    expect(redactTransportSecrets('smtp_password=super-secret token=abc')).toBe(
      'smtp_password=*** token=***',
    );
    expect(shapeUnreadCount(120)).toEqual({ count: 120, badge: '99+' });
    expect(containsCommercialProposalFields({ amountB: '10' })).toBe(true);
    expect(containsCommercialProposalFields({ body: 'ok' })).toBe(false);
    expect(parseNotificationListQuery({ page: '2', filter: 'unread' }).filter).toBe('unread');
    expect(() => parseNotificationListQuery({ pageSize: '500' })).toThrow();
    expect(parseSlaListQuery({ bucket: 'WARNING', page: '1' }).bucket).toBe('WARNING');
    expect(() => parseSlaListQuery({ extra: 'yes' })).toThrow();
  });
});
