import type { UserRole } from '@sgr-registry/contracts';
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
  if (input.role !== 'RESPONSIBLE_ENGINEER') {
    return true;
  }
  if (isProposalBcEvent(event)) {
    return false;
  }
  if (HEADER_ACTIONS.has(event.action) && event.entityId === input.actId) {
    return true;
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
  if (role !== 'RESPONSIBLE_ENGINEER') {
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
