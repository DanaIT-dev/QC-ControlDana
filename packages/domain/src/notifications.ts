import {
  notificationListQuerySchema,
  slaListQuerySchema,
  type NotificationType,
  type SlaClockKind,
  type UserRole,
} from '@sgr-registry/contracts';
import { isOversightRole } from './capabilities';
import { ValidationError } from './errors';
import { assertAuditPayloadSafe, containsSensitiveAuditKey } from './secrets';
import { isBusinessStaffRole } from './role-hierarchy';

export type { NotificationType, SlaClockKind };

const COMMERCIAL_PAYLOAD_KEYS = [
  'proposalB',
  'proposalC',
  'amountB',
  'amountC',
  'slotB',
  'slotC',
  'proposalAmountB',
  'proposalAmountC',
];

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  RESPONSIBLE_ASSIGNED: 'Назначение ответственным',
  EFFECTIVE_DEADLINE_CHANGED: 'Изменён установленный срок',
  THIRD_PARTY_DEADLINE_CHANGED: 'Изменён срок третьей стороны',
  DEFECT_COMPLETED: 'Дефект завершён',
  DEFECT_REOPENED: 'Дефект возвращён в работу',
  ATTACHMENT_READY: 'Файл прошёл проверку',
  ATTACHMENT_REJECTED: 'Файл отклонён',
  ATTACHMENT_SCAN_FAILED: 'Не удалось проверить файл',
  SLA_WARNING: 'Приближается срок',
  SLA_DUE_TODAY: 'Срок сегодня',
  SLA_OVERDUE: 'Просрочка срока',
  ACT_CHAT_MENTION: 'Упоминание в обсуждении акта',
  ORGANIZATION_DETAILS_INCOMPLETE: 'Неполные данные организации',
};

export function buildOccurrenceKey(parts: Array<string | number | null | undefined>): string {
  return parts.map((part) => String(part ?? '')).join(':');
}

export function uniqueRecipientIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))].sort();
}

export function suppressActorRecipients(
  recipientIds: string[],
  actorUserId: string | null | undefined,
  options: { automatic: boolean },
): string[] {
  if (options.automatic || !actorUserId) {
    return uniqueRecipientIds(recipientIds);
  }
  return uniqueRecipientIds(recipientIds.filter((id) => id !== actorUserId));
}

export function recipientsForDeadlineAlert(input: {
  kind: SlaClockKind;
  threshold: number | null;
  assignedResponsibleIds: string[];
  contractorIds: string[];
  sgrManagerIds: string[];
  adminIds: string[];
}): string[] {
  const includeAdmin = input.threshold !== null && input.threshold >= 3;
  if (input.kind === 'GENERAL') {
    return uniqueRecipientIds([
      ...input.assignedResponsibleIds,
      ...input.sgrManagerIds,
      ...(includeAdmin ? input.adminIds : []),
    ]);
  }
  return uniqueRecipientIds([
    ...input.contractorIds,
    ...input.sgrManagerIds,
    ...(includeAdmin ? input.adminIds : []),
  ]);
}

export function canReceiveDeadlineKind(role: UserRole, kind: SlaClockKind): boolean {
  if (isOversightRole(role) || isBusinessStaffRole(role)) {
    return true;
  }
  if (role === 'RESPONSIBLE_ENGINEER') {
    return kind === 'GENERAL';
  }
  return kind === 'THIRD_PARTY';
}

export function notificationTitle(type: NotificationType): string {
  return NOTIFICATION_TYPE_LABELS[type];
}

export function containsCommercialProposalFields(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsCommercialProposalFields);
  }
  if (typeof value !== 'object') {
    return false;
  }
  return Object.entries(value).some(([key, nested]) => {
    const folded = key.toLowerCase();
    if (COMMERCIAL_PAYLOAD_KEYS.some((item) => folded === item.toLowerCase())) {
      return true;
    }
    return containsCommercialProposalFields(nested);
  });
}

export function assertSafeNotificationPayload(payload: unknown): void {
  assertAuditPayloadSafe(payload);
  if (containsSensitiveAuditKey(payload) || containsCommercialProposalFields(payload)) {
    throw new ValidationError('payload', 'Недопустимые поля уведомления');
  }
}

export function parseNotificationListQuery(query: Record<string, string | undefined>) {
  const parsed = notificationListQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError('query', 'Некорректные параметры списка уведомлений');
  }
  return parsed.data;
}

export function parseSlaListQuery(query: Record<string, string | undefined>) {
  const parsed = slaListQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError('query', 'Некорректные параметры контроля сроков');
  }
  return parsed.data;
}

export function shapeUnreadCount(count: number): { count: number; badge: string } {
  if (count > 99) {
    return { count, badge: '99+' };
  }
  return { count, badge: String(count) };
}

export const NOTIFICATION_PAGE_SIZES = [20, 50] as const;
export const DEFAULT_NOTIFICATION_PAGE_SIZE = 20;
export const SLA_PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_SLA_PAGE_SIZE = 25;
