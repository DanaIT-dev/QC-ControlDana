export const OUTBOX_MAX_ATTEMPTS = 8;
export const EMAIL_MAX_ATTEMPTS = 8;

export function exponentialBackoffMs(attempt: number, baseMs = 30_000): number {
  const capped = Math.min(Math.max(attempt, 1), 10);
  return Math.min(baseMs * 2 ** (capped - 1), 60 * 60 * 1000);
}

export function nextAttemptAt(attempt: number, now = new Date()): Date {
  return new Date(now.getTime() + exponentialBackoffMs(attempt));
}

export function isTerminalAttempt(attempt: number, max = OUTBOX_MAX_ATTEMPTS): boolean {
  return attempt >= max;
}

export function resolveNotificationQueueName(nodeEnv = process.env.NODE_ENV): string {
  return nodeEnv === 'test' ? 'sgr-notifications-test' : 'sgr-notifications';
}

export const OUTBOX_DISPATCH_JOB = 'outbox.dispatch';
export const EMAIL_DELIVER_JOB = 'email.deliver';
export const SLA_EVALUATE_JOB = 'sla.evaluate-daily';
export const OUTBOX_RECOVERY_JOB = 'outbox.recover';

/** BullMQ custom jobId cannot contain `:`. */
export function outboxJobId(outboxId: string): string {
  return `outbox-${outboxId}`;
}

export function emailJobId(deliveryId: string): string {
  return `email-${deliveryId}`;
}

export function slaCatchUpJobId(businessDate: string): string {
  return `sla-${businessDate}`;
}
