import { describe, expect, it } from 'vitest';
import {
  resolveAttachmentQueueName,
  resolveMaintenanceQueueName,
  resolveNotificationQueueName,
} from './outbox';
import {
  parseWorkerHeartbeat,
  resolveSlaEvaluationLockKey,
  resolveWorkerHeartbeatKey,
  serializeWorkerHeartbeat,
} from './worker-heartbeat';

describe('worker heartbeat and queue isolation', () => {
  it('serializes only pid and timestamps', () => {
    const payload = serializeWorkerHeartbeat({
      pid: 42,
      startedAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:05.000Z',
    });
    expect(payload).not.toMatch(/password|secret|REDIS|SMTP|DATABASE/i);
    expect(JSON.parse(payload)).toEqual({
      pid: 42,
      startedAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:05.000Z',
    });
  });

  it('is up while the key is present and down when missing or stale payload', () => {
    const now = new Date('2026-08-28T12:00:10.000Z');
    const raw = serializeWorkerHeartbeat({
      pid: 1,
      startedAt: '2026-08-28T12:00:00.000Z',
      updatedAt: '2026-08-28T12:00:08.000Z',
    });
    expect(parseWorkerHeartbeat(raw, now)).toEqual({ status: 'up', ageMs: 2000 });
    expect(parseWorkerHeartbeat(null, now)).toEqual({ status: 'down', ageMs: null });
    expect(parseWorkerHeartbeat('not-json', now)).toEqual({ status: 'down', ageMs: null });
  });

  it('uses isolated development/test keys and queue names', () => {
    expect(resolveWorkerHeartbeatKey('development')).toBe('sgr:worker:heartbeat');
    expect(resolveWorkerHeartbeatKey('test')).toBe('sgr:worker:heartbeat:test');
    expect(resolveSlaEvaluationLockKey('2026-08-28', 'development')).toBe(
      'sgr:sla:eval:2026-08-28',
    );
    expect(resolveSlaEvaluationLockKey('2026-08-28', 'test')).toBe('sgr-test:sla:eval:2026-08-28');
    expect(resolveNotificationQueueName('development')).toBe('sgr-notifications');
    expect(resolveNotificationQueueName('test')).toBe('sgr-notifications-test');
    expect(resolveAttachmentQueueName('development')).toBe('sgr-attachments');
    expect(resolveAttachmentQueueName('test')).toBe('sgr-attachments-test');
    expect(resolveMaintenanceQueueName('development')).toBe('sgr-maintenance');
    expect(resolveMaintenanceQueueName('test')).toBe('sgr-maintenance-test');
  });
});
