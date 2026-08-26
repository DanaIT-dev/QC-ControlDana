import type { ActStatus, DefectItemStatus } from '@sgr-registry/contracts';
import { ActCancellationError } from './errors';

export interface ActDefectItemRef {
  status: DefectItemStatus;
  active: boolean;
}

export function computeActStatus(items: readonly ActDefectItemRef[]): ActStatus {
  const activeItems = items.filter((item) => item.active);
  if (activeItems.some((item) => item.status === 'IN_PROGRESS')) {
    return 'IN_PROGRESS';
  }
  if (activeItems.length > 0 && activeItems.every((item) => item.status === 'COMPLETED')) {
    return 'COMPLETED';
  }
  return 'IN_PROGRESS';
}

export interface CancellableAct {
  status: ActStatus;
  cancelledAt: Date | null;
}

export function cancelAct(
  act: CancellableAct,
  input: { reason: string; cancelledByUserId: string; now?: Date },
): CancellableAct & { cancellationReason: string; cancelledByUserId: string; status: 'CANCELLED' } {
  if (!input.reason.trim()) {
    throw new ActCancellationError('Cancellation reason is required');
  }
  if (!input.cancelledByUserId) {
    throw new ActCancellationError('Cancellation must record the acting user');
  }
  if (act.cancelledAt !== null) {
    throw new ActCancellationError('Act is already cancelled');
  }

  return {
    ...act,
    status: 'CANCELLED',
    cancelledAt: input.now ?? new Date(),
    cancellationReason: input.reason.trim(),
    cancelledByUserId: input.cancelledByUserId,
  };
}
