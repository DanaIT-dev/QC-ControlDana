export function resolveAttachmentQueueName(nodeEnv = process.env.NODE_ENV): string {
  return nodeEnv === 'test' ? 'sgr-attachments-test' : 'sgr-attachments';
}

export const ATTACHMENT_QUEUE = resolveAttachmentQueueName();
export const ATTACHMENT_SCAN_JOB = 'attachment.scan';
export const ATTACHMENT_RECOVERY_JOB = 'attachment.recover';
