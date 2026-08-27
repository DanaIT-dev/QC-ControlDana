import type { DefectItemStatus } from '@sgr-registry/contracts';
import { DefectItemCompletionError, InvalidTransitionError } from './errors';
import { calendarDateInTimeZone, BUSINESS_TIME_ZONE } from './deadline';

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

export function assertReadyAtNotFuture(
  readyAt: Date,
  now: Date = new Date(),
  timeZone: string = BUSINESS_TIME_ZONE,
): void {
  const readyDate = calendarDateInTimeZone(readyAt, timeZone);
  const today = calendarDateInTimeZone(now, timeZone);
  if (readyDate > today) {
    throw new DefectItemCompletionError('Дата исполнения не может быть позже сегодняшнего дня');
  }
}

export function completeDefectItem(
  item: DefectItemState,
  options: { readyAt?: Date; autoFillReadyAt?: boolean; now?: Date; timeZone?: string } = {},
): DefectItemState {
  if (item.status === 'COMPLETED') {
    return item;
  }
  if (item.status !== 'IN_PROGRESS') {
    throw new InvalidTransitionError('Дефект можно завершить только из статуса «В работе»');
  }

  const now = options.now ?? new Date();
  const autoFill = options.autoFillReadyAt ?? options.readyAt === undefined;
  const readyAt = options.readyAt ?? (autoFill ? now : null);

  if (readyAt === null) {
    throw new DefectItemCompletionError(
      'DefectItem cannot be completed without readyAt or server-side auto-fill',
    );
  }
  assertReadyAtNotFuture(readyAt, now, options.timeZone);

  return {
    ...item,
    status: 'COMPLETED',
    readyAt,
  };
}

export function reopenDefectItem(
  item: DefectItemState,
  options: { reason: string },
): DefectItemState {
  if (!options.reason.trim()) {
    throw new InvalidTransitionError('Для возврата в работу нужна причина');
  }
  if (item.status !== 'COMPLETED') {
    throw new InvalidTransitionError('Вернуть в работу можно только завершённый дефект');
  }
  return {
    ...item,
    status: 'IN_PROGRESS',
    readyAt: null,
  };
}
