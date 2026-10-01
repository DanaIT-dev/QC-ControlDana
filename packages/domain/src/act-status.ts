import type { ActStatus, DefectItemStatus } from '@sgr-registry/contracts';
import { ActCancellationError } from './errors';

export interface ActDefectItemRef {
  status: DefectItemStatus;
  active: boolean;
}

export interface ActWorkflowState {
  startedAt: Date | string | null;
  cancelledAt?: Date | string | null;
}

export function computeActStatus(
  items: readonly ActDefectItemRef[],
  workflow: ActWorkflowState,
  options?: { currentStatus?: ActStatus },
): ActStatus {
  if (workflow.cancelledAt) {
    return 'CANCELLED';
  }
  if (workflow.startedAt == null) {
    if (options?.currentStatus === 'IMPORTED_UNSPECIFIED') {
      return 'IMPORTED_UNSPECIFIED';
    }
    if (options?.currentStatus === 'IN_PROGRESS') {
      return 'IN_PROGRESS';
    }
    return 'NEW';
  }
  const activeItems = items.filter((item) => item.active);
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
  if (act.status === 'COMPLETED') {
    throw new ActCancellationError('Завершённый акт нельзя аннулировать');
  }
  if (act.cancelledAt !== null || act.status === 'CANCELLED') {
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
