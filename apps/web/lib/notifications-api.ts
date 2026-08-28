import type {
  NotificationListResponse,
  NotificationSettingsResponse,
  SlaListResponse,
  SlaSummaryResponse,
  UnreadCountResponse,
} from '@sgr-registry/contracts';
import { CSRF_HEADER_NAME } from '@sgr-registry/domain';

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status}`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

async function mutateJson<T>(
  path: string,
  method: 'POST' | 'PATCH',
  csrfToken: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      [CSRF_HEADER_NAME]: csrfToken,
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    const error = new Error('Не удалось выполнить действие') as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return data as T;
}

export function fetchUnreadCount(): Promise<UnreadCountResponse> {
  return getJson('/api/notifications/unread-count');
}

export function fetchNotifications(input: {
  page?: number;
  filter?: 'all' | 'unread';
}): Promise<NotificationListResponse> {
  const params = new URLSearchParams();
  if (input.page) params.set('page', String(input.page));
  if (input.filter) params.set('filter', input.filter);
  const suffix = params.toString();
  return getJson(`/api/notifications${suffix ? `?${suffix}` : ''}`);
}

export function markNotificationRead(id: string, csrfToken: string) {
  return mutateJson<{ ok: true }>(`/api/notifications/${id}/read`, 'PATCH', csrfToken);
}

export function markAllNotificationsRead(csrfToken: string) {
  return mutateJson<{ ok: true; count: number }>('/api/notifications/read-all', 'POST', csrfToken);
}

export function fetchSlaSummary(): Promise<SlaSummaryResponse> {
  return getJson('/api/sla/summary');
}

export function fetchSlaItems(search: string): Promise<SlaListResponse> {
  return getJson(`/api/sla/items${search}`);
}

export function fetchNotificationSettings(): Promise<NotificationSettingsResponse> {
  return getJson('/api/system/notification-settings');
}

export function patchNotificationSettings(
  csrfToken: string,
  body: {
    expectedVersion: number;
    deadlineWarningDays?: number;
    escalationDays?: number[];
    dailyEvaluationTime?: string;
    emailEnabled?: boolean;
  },
) {
  return mutateJson<NotificationSettingsResponse>(
    '/api/system/notification-settings',
    'PATCH',
    csrfToken,
    body,
  );
}
