import { z } from 'zod';
import { USER_ROLES, USER_STATUSES } from './enums';

const uuid = z.uuid();

export const createActChatMessageRequestSchema = z
  .object({
    body: z.string(),
    mentionedUserIds: z.array(uuid).max(20).optional(),
    clientMessageId: uuid,
  })
  .strict();

export const actChatListQuerySchema = z
  .object({
    before: z.string().optional(),
    after: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict()
  .refine((value) => !(value.before && value.after), {
    message: 'Нельзя сочетать before и after',
  });

export const actChatMentionCandidatesQuerySchema = z
  .object({
    q: z.string().max(100).optional(),
  })
  .strict();

export type CreateActChatMessageRequest = z.infer<typeof createActChatMessageRequestSchema>;
export type ActChatListQuery = z.infer<typeof actChatListQuerySchema>;
export type ActChatMentionCandidatesQuery = z.infer<typeof actChatMentionCandidatesQuerySchema>;

export interface ActChatAuthorDto {
  id: string;
  fullName: string;
  role: (typeof USER_ROLES)[number];
  roleLabel: string;
  status: (typeof USER_STATUSES)[number];
}

export interface ActChatMentionDto {
  userId: string;
  fullName: string;
}

export interface ActChatMessageDto {
  id: string;
  actId: string;
  body: string;
  createdAt: string;
  clientMessageId: string;
  author: ActChatAuthorDto;
  mentions: ActChatMentionDto[];
}

export interface ActChatListResponse {
  items: ActChatMessageDto[];
  hasOlder: boolean;
  olderCursor: string | null;
  newestCursor: string | null;
}

export interface ActChatMentionCandidateDto {
  id: string;
  fullName: string;
  role: (typeof USER_ROLES)[number];
  roleLabel: string;
}

export interface ActChatMentionCandidatesResponse {
  items: ActChatMentionCandidateDto[];
}
