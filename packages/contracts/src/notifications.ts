import { z } from 'zod';
import { NOTIFICATION_TYPES } from './enums';
import type { ReadyResponse, SystemStatusOverviewItem } from './health';

export const notificationListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(50).optional(),
    filter: z.enum(['all', 'unread']).optional(),
  })
  .strict();

export const notificationSettingsPatchSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    deadlineWarningDays: z.number().int().positive().optional(),
    escalationDays: z.array(z.number().int().nonnegative()).optional(),
    dailyEvaluationTime: z.string().optional(),
    emailEnabled: z.boolean().optional(),
  })
  .strict();

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
export type NotificationSettingsPatch = z.infer<typeof notificationSettingsPatchSchema>;

export interface NotificationListItem {
  id: string;
  type: (typeof NOTIFICATION_TYPES)[number];
  title: string;
  body: string;
  occurredAt: string;
  readAt: string | null;
  actId: string | null;
  defectItemId: string | null;
  organizationId: string | null;
}

export interface NotificationListResponse {
  items: NotificationListItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface UnreadCountResponse {
  count: number;
  badge: string;
}

export interface NotificationSettingsResponse {
  version: number;
  deadlineWarningDays: number;
  escalationDays: number[];
  dailyEvaluationTime: string;
  emailEnabled: boolean;
}

export interface NotificationOpsStatus {
  outboxPending: number;
  oldestPendingOutboxAgeMs: number | null;
  emailQueued: number;
  emailFailed: number;
  emailDead: number;
  lastSlaBusinessDate: string | null;
  lastSlaRunAt: string | null;
  nextSlaRunAt: string | null;
  smtp: { status: 'up' | 'down' | 'disabled'; latencyMs?: number };
  worker: {
    status: 'up' | 'down';
    heartbeatAgeMs: number | null;
    waiting: number;
    active: number;
    failed: number;
    delayed: number;
  };
}

export interface SystemStatusResponse {
  status: 'ready' | 'not_ready' | 'degraded';
  timestamp: string;
  components: ReadyResponse['components'] & {
    smtp?: { status: 'up' | 'down' | 'disabled'; latencyMs?: number };
  };
  overview?: SystemStatusOverviewItem[];
  notifications?: NotificationOpsStatus;
}
