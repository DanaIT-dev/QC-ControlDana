import {
  ACT_FORM_DISPLAY,
  REGISTRY_STATUS_FILTERS,
  type ActFormCode,
  type ActStatus,
  type DefectItemStatus,
  type RegistryStatusFilter,
} from '@sgr-registry/contracts';
import type { DeadlineState } from '@sgr-registry/contracts';

export const DEFECT_ITEM_STATUS_LABELS: Record<DefectItemStatus, string> = {
  IN_PROGRESS: 'В работе',
  COMPLETED: 'Исполнено',
};

export const ACT_STATUS_LABELS: Record<ActStatus, string> = {
  NEW: 'Новый акт',
  IN_PROGRESS: 'В работе',
  COMPLETED: 'Исполнено',
  CANCELLED: 'Аннулирован',
};

export const REGISTRY_STATUS_FILTER_OPTIONS: Array<{ id: RegistryStatusFilter; label: string }> =
  REGISTRY_STATUS_FILTERS.map((id) => ({ id, label: ACT_STATUS_LABELS[id] }));

export const DEADLINE_STATE_LABELS: Record<DeadlineState, string> = {
  NO_DEADLINE: 'Срок не установлен',
  NORMAL: 'В срок',
  WARNING: 'Срок приближается',
  OVERDUE: 'Просрочено',
  COMPLETED: 'Исполнено',
};

export function formLabel(formCode: ActFormCode): string {
  return ACT_FORM_DISPLAY[formCode].officialLabel;
}

export function defectItemStatusLabel(status: DefectItemStatus): string {
  return DEFECT_ITEM_STATUS_LABELS[status];
}

export function actStatusLabel(status: ActStatus): string {
  return ACT_STATUS_LABELS[status];
}

export function displayedRegistryStatus(input: {
  actStatus: ActStatus;
  actStatusLabel: string;
  defectStatus: DefectItemStatus;
  defectStatusLabel: string;
}): { status: ActStatus | DefectItemStatus; label: string } {
  if (input.actStatus === 'NEW') {
    return { status: 'NEW', label: input.actStatusLabel };
  }
  return { status: input.defectStatus, label: input.defectStatusLabel };
}

export function deadlineStateLabel(state: DeadlineState): string {
  const label = DEADLINE_STATE_LABELS[state];
  if (!label) {
    throw new Error('Unknown deadline state');
  }
  return label;
}
