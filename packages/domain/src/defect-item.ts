import type { DefectItemStatus } from '@sgr-registry/contracts';
import { DefectItemCompletionError } from './errors';

export interface DefectItemState {
  id: string;
  actId: string;
  status: DefectItemStatus;
  readyAt: Date | null;
}

export interface CreateDefectItemInput {
  id: string;
  actId: string;
}

export function createDefectItem(input: CreateDefectItemInput): DefectItemState {
  return {
    id: input.id,
    actId: input.actId,
    status: 'IN_PROGRESS',
    readyAt: null,
  };
}

export function completeDefectItem(
  item: DefectItemState,
  options: { readyAt?: Date; autoFillReadyAt?: boolean; now?: Date } = {},
): DefectItemState {
  const now = options.now ?? new Date();
  const autoFill = options.autoFillReadyAt ?? options.readyAt === undefined;
  const readyAt = options.readyAt ?? (autoFill ? now : null);

  if (readyAt === null) {
    throw new DefectItemCompletionError(
      'DefectItem cannot be completed without readyAt or server-side auto-fill',
    );
  }

  return {
    ...item,
    status: 'COMPLETED',
    readyAt,
  };
}
