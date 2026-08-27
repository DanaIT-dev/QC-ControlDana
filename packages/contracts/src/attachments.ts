import { z } from 'zod';
import { ATTACHMENT_CATEGORIES, ATTACHMENT_STATUSES, ATTACHMENT_OWNER_TYPES } from './enums';

export const attachmentLimitsSchema = z.object({
  maxBytes: z.number().int().positive(),
  maxPerOwner: z.number().int().positive(),
  allowedMimeTypes: z.array(z.string()),
  allowedExtensions: z.array(z.string()),
});

export const attachmentItemSchema = z.object({
  id: z.string().uuid(),
  ownerType: z.enum(ATTACHMENT_OWNER_TYPES),
  ownerId: z.string().uuid(),
  category: z.enum(ATTACHMENT_CATEGORIES),
  safeDisplayName: z.string(),
  sizeBytes: z.string(),
  detectedMimeType: z.string().nullable(),
  status: z.enum(ATTACHMENT_STATUSES),
  uploadedBy: z.object({
    id: z.string().uuid(),
    fullName: z.string(),
  }),
  createdAt: z.string(),
  scannedAt: z.string().nullable(),
  version: z.number().int(),
  canPreview: z.boolean(),
  canDownload: z.boolean(),
  canArchive: z.boolean(),
});

export const attachmentListResponseSchema = z.object({
  items: z.array(attachmentItemSchema),
  activeCount: z.number().int().nonnegative(),
  limits: attachmentLimitsSchema,
  allowedMimeTypes: z.array(z.string()),
  capabilities: z.object({
    canUpload: z.boolean(),
    canArchive: z.boolean(),
    canDownload: z.boolean(),
  }),
});

export const archiveAttachmentRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
});

export type AttachmentItemDto = z.infer<typeof attachmentItemSchema>;
export type AttachmentListResponse = z.infer<typeof attachmentListResponseSchema>;
export type ArchiveAttachmentRequest = z.infer<typeof archiveAttachmentRequestSchema>;
