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

export function resolveMaintenanceQueueName(nodeEnv = process.env.NODE_ENV): string {
  return nodeEnv === 'test' ? 'sgr-maintenance-test' : 'sgr-maintenance';
}

export function resolveNotificationQueueName(nodeEnv = process.env.NODE_ENV): string {
  return nodeEnv === 'test' ? 'sgr-notifications-test' : 'sgr-notifications';
}

export function resolveAttachmentQueueName(nodeEnv = process.env.NODE_ENV): string {
  return nodeEnv === 'test' ? 'sgr-attachments-test' : 'sgr-attachments';
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

export const DEFAULT_SMTP_TIMEOUT_MS = 8_000;
export const SMTP_LEASE_GRACE_MS = 5_000;
export const OUTBOX_CLAIM_LEASE_MS = 15_000;
export const PREVIOUS_RLS_TX_TIMEOUT_MS = 20_000;

export type SmtpErrorCode =
  'SMTP_TIMEOUT' | 'SMTP_CONNECTION' | 'SMTP_4XX' | 'SMTP_5XX' | 'SMTP_ERROR';

export type SmtpErrorClass = {
  code: SmtpErrorCode;
  retryable: boolean;
};

export function emailLeaseMs(smtpTimeoutMs = DEFAULT_SMTP_TIMEOUT_MS): number {
  return Math.max(smtpTimeoutMs, 1_000) + SMTP_LEASE_GRACE_MS;
}

export function leaseUntil(leaseMs: number, now = new Date()): Date {
  return new Date(now.getTime() + leaseMs);
}

export function emailMessageId(deliveryId: string, fromAddress: string): string {
  const hostPart = fromAddress.split('@').at(-1)?.trim() ?? '';
  const host = hostPart.replace(/[^\w.-]/g, '') || 'sgr-registry.local';
  return `${deliveryId}@${host}`;
}

export function classifySmtpError(error: unknown): SmtpErrorClass {
  const err = error as {
    code?: string;
    responseCode?: number;
    message?: string;
    command?: string;
    errno?: string;
  };
  const responseCode = Number(err.responseCode);
  if (Number.isFinite(responseCode) && responseCode >= 500 && responseCode < 600) {
    return { code: 'SMTP_5XX', retryable: false };
  }
  if (Number.isFinite(responseCode) && responseCode >= 400 && responseCode < 500) {
    return { code: 'SMTP_4XX', retryable: true };
  }
  const code = `${err.code ?? err.errno ?? ''}`.toUpperCase();
  const message = `${err.message ?? ''}`;
  if (code.includes('TIMEOUT') || code.includes('TIMEDOUT') || /timed?\s*out/i.test(message)) {
    return { code: 'SMTP_TIMEOUT', retryable: true };
  }
  if (
    code === 'ECONNECTION' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE' ||
    code === 'ECONNRESET' ||
    code === 'ESOCKET'
  ) {
    return { code: 'SMTP_CONNECTION', retryable: true };
  }
  return { code: 'SMTP_ERROR', retryable: true };
}

const SECRET_PATTERN =
  /(password|passwd|smtp_password|smtp_user|smtp_pass|token|secret|authorization)=([^\s&]+)/gi;

export function redactTransportSecrets(value: string): string {
  return value.replace(SECRET_PATTERN, '$1=***');
}

export function smtpLogCode(error: unknown): string {
  return classifySmtpError(error).code;
}
