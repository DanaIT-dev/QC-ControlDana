import type { UserRole } from '@sgr-registry/contracts';
import { canViewAssignedHistory, canViewFullHistory } from './capabilities';
import { visibleProposalSlots } from './registry-access';

export const AUDIT_ACTIONS = [
  'USER_CREATED',
  'USER_UPDATED',
  'USER_ARCHIVED',
  'USER_RESTORED',
  'USER_PASSWORD_RESET',
  'USER_PASSWORD_CHANGED',
  'REFERENCE_CREATED',
  'REFERENCE_UPDATED',
  'REFERENCE_ARCHIVED',
  'REFERENCE_RESTORED',
  'OBJECT_ENGINEERS_REPLACED',
  'ACT_CREATED',
  'ACT_HEADER_UPDATED',
  'DEFECT_ADDED',
  'ASSIGNMENTS_REPLACED',
  'DEADLINE_UPDATED',
  'DEFECT_COMPLETED',
  'DEFECT_REOPENED',
  'PROPOSAL_UPSERTED',
  'PROPOSAL_ARCHIVED',
  'PROPOSAL_RESTORED',
  'ATTACHMENT_UPLOADED',
  'ATTACHMENT_SCAN_STARTED',
  'ATTACHMENT_SCAN_PASSED',
  'ATTACHMENT_REJECTED',
  'ATTACHMENT_SCAN_FAILED',
  'ATTACHMENT_ARCHIVED',
  'ACT_CHAT_MESSAGE_CREATED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTION_LABELS: Record<AuditAction | string, string> = {
  USER_CREATED: 'Создан пользователь',
  USER_UPDATED: 'Изменён пользователь',
  USER_ARCHIVED: 'Пользователь архивирован',
  USER_RESTORED: 'Пользователь восстановлен',
  USER_PASSWORD_RESET: 'Сброшен пароль',
  USER_PASSWORD_CHANGED: 'Пароль изменён',
  REFERENCE_CREATED: 'Создано значение справочника',
  REFERENCE_UPDATED: 'Изменено значение справочника',
  REFERENCE_ARCHIVED: 'Значение справочника архивировано',
  REFERENCE_RESTORED: 'Значение справочника восстановлено',
  OBJECT_ENGINEERS_REPLACED: 'Изменены ответственные инженеры объекта',
  ACT_CREATED: 'Создан акт',
  ACT_HEADER_UPDATED: 'Изменены данные акта',
  DEFECT_ADDED: 'Добавлен дефект',
  ASSIGNMENTS_REPLACED: 'Изменены назначения',
  DEADLINE_UPDATED: 'Изменён срок',
  DEFECT_COMPLETED: 'Дефект исполнен',
  DEFECT_REOPENED: 'Дефект возвращён в работу',
  PROPOSAL_UPSERTED: 'Обновлено предложение',
  PROPOSAL_ARCHIVED: 'Предложение отозвано',
  PROPOSAL_RESTORED: 'Предложение восстановлено',
  ATTACHMENT_UPLOADED: 'Загружено вложение',
  ATTACHMENT_SCAN_STARTED: 'Начата проверка вложения',
  ATTACHMENT_SCAN_PASSED: 'Вложение прошло проверку',
  ATTACHMENT_REJECTED: 'Вложение отклонено',
  ATTACHMENT_SCAN_FAILED: 'Не удалось проверить вложение',
  ATTACHMENT_ARCHIVED: 'Вложение архивировано',
  ACT_CHAT_MESSAGE_CREATED: 'Сообщение в обсуждении акта',
  LOGIN_SUCCEEDED: 'Вход выполнен',
  LOGIN_FAILED: 'Неудачная попытка входа',
  LOGIN_RATE_LIMITED: 'Превышен лимит попыток входа',
  LOGOUT: 'Выход',
  LOGOUT_ALL: 'Выход на всех устройствах',
  SESSION_REJECTED_ARCHIVED_USER: 'Сессия отклонена: пользователь архивирован',
  SESSION_REJECTED_VERSION_MISMATCH: 'Сессия отклонена: версия сессии устарела',
};

const HEADER_ACTIONS = new Set(['ACT_CREATED', 'ACT_HEADER_UPDATED']);
const PROPOSAL_ACTIONS = new Set(['PROPOSAL_UPSERTED', 'PROPOSAL_ARCHIVED', 'PROPOSAL_RESTORED']);
const ATTACHMENT_ACTIONS = new Set([
  'ATTACHMENT_UPLOADED',
  'ATTACHMENT_SCAN_STARTED',
  'ATTACHMENT_SCAN_PASSED',
  'ATTACHMENT_REJECTED',
  'ATTACHMENT_SCAN_FAILED',
  'ATTACHMENT_ARCHIVED',
]);

export interface HistoryEventSource {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  parentEntityType: string | null;
  parentEntityId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  actorUserId: string | null;
  actorName: string | null;
  occurredAt: Date;
  requestId: string | null;
}

export function isProposalBcEvent(event: HistoryEventSource): boolean {
  if (!PROPOSAL_ACTIONS.has(event.action)) {
    return false;
  }
  const slot =
    readSlot(event.newValue) ??
    readSlot(event.oldValue) ??
    (event.entityType === 'PROPOSAL' ? undefined : undefined);
  return slot === 'B' || slot === 'C';
}

function readSlot(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const slot = (value as { slot?: unknown }).slot;
  return typeof slot === 'string' ? slot : undefined;
}

export function historyVisibleToRole(
  event: HistoryEventSource,
  input: { role: UserRole; assignedDefectItemIds: ReadonlySet<string>; actId: string },
): boolean {
  if (canViewFullHistory(input.role)) {
    return true;
  }
  if (!canViewAssignedHistory(input.role)) {
    return false;
  }
  if (isProposalBcEvent(event)) {
    return false;
  }
  if (HEADER_ACTIONS.has(event.action) && event.entityId === input.actId) {
    return true;
  }
  if (event.action === 'ACT_CHAT_MESSAGE_CREATED' && event.parentEntityId === input.actId) {
    return true;
  }
  if (ATTACHMENT_ACTIONS.has(event.action)) {
    const slot = readSlot(event.newValue) ?? readSlot(event.oldValue);
    if (slot === 'B' || slot === 'C') {
      return false;
    }
    if (event.parentEntityType === 'ACT' && event.parentEntityId === input.actId) {
      return true;
    }
    const attachmentDefectId =
      event.parentEntityType === 'DEFECT_ITEM' ? event.parentEntityId : null;
    if (attachmentDefectId && input.assignedDefectItemIds.has(attachmentDefectId)) {
      return true;
    }
    return false;
  }
  const defectId =
    event.entityType === 'DEFECT_ITEM'
      ? event.entityId
      : event.parentEntityType === 'DEFECT_ITEM'
        ? event.parentEntityId
        : null;
  if (defectId && input.assignedDefectItemIds.has(defectId)) {
    return true;
  }
  return false;
}

export function shapeHistoryForRole(event: HistoryEventSource, role: UserRole): HistoryEventSource {
  if (!canViewAssignedHistory(role) || canViewFullHistory(role)) {
    return event;
  }
  return {
    ...event,
    oldValue: stripBc(event.oldValue),
    newValue: stripBc(event.newValue),
  };
}

function stripBc(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = { ...(value as Record<string, unknown>) };
  delete record.proposalB;
  delete record.proposalC;
  delete record.proposalsBC;
  if (record.slot === 'B' || record.slot === 'C') {
    return {};
  }
  return record;
}

export function visibleProposalSlotsForHistory(role: UserRole) {
  return visibleProposalSlots(role);
}
