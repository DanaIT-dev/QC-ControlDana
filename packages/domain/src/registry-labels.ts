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
  PENDING_INSPECTION: 'На проверке',
  COMPLETED: 'Исполнено',
};

export const ACT_STATUS_LABELS: Record<ActStatus, string> = {
  NEW: 'Новый акт',
  IMPORTED_UNSPECIFIED: 'Статус не указан',
  IN_PROGRESS: 'В работе',
  COMPLETED: 'Исполнено',
  CANCELLED: 'Аннулирован',
};

export const MISSING_IMPORTED_DESCRIPTION_LABEL = 'Описание отсутствует в исходном реестре';
export const MISSING_IMPORTED_LOCATION_LABEL = '—';
export const DISPLAY_ACT_NUMBER_FALLBACK = 'Без номера';

export function displayActNumber(input: {
  officialNumber?: string | null;
  sourceActNumberRaw?: string | null;
}): string {
  const official = input.officialNumber?.trim();
  if (official) {
    return official;
  }
  const source = input.sourceActNumberRaw?.trim();
  if (source) {
    return source;
  }
  return DISPLAY_ACT_NUMBER_FALLBACK;
}

export function importedDescriptionLabel(claimDetails: string | null | undefined): string {
  if (claimDetails && claimDetails.trim().length > 0) {
    return claimDetails;
  }
  return MISSING_IMPORTED_DESCRIPTION_LABEL;
}

export const REGISTRY_STATUS_FILTER_OPTIONS: Array<{ id: RegistryStatusFilter; label: string }> =
  REGISTRY_STATUS_FILTERS.map((id) => ({ id, label: ACT_STATUS_LABELS[id] }));

export const DEADLINE_STATE_LABELS: Record<DeadlineState, string> = {
  NO_DEADLINE: 'Срок не установлен',
  NORMAL: 'В срок',
  WARNING: 'Срок приближается',
  OVERDUE: 'Просрочено',
  COMPLETED: 'Исполнено',
};

export function formLabel(formCode: ActFormCode | null | undefined): string {
  if (!formCode) {
    return 'Черновик';
  }
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
  if (input.actStatus === 'NEW' || input.actStatus === 'IMPORTED_UNSPECIFIED') {
    return { status: input.actStatus, label: input.actStatusLabel };
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
