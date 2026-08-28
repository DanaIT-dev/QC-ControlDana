import { resolveAttachmentQueueName } from '@sgr-registry/domain';

export { resolveAttachmentQueueName };

export const ATTACHMENT_QUEUE = resolveAttachmentQueueName();
export const ATTACHMENT_SCAN_JOB = 'attachment.scan';
export const ATTACHMENT_RECOVERY_JOB = 'attachment.recover';
