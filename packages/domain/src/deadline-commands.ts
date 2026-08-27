import type { Capability } from './capabilities';
import { hasCapability } from './capabilities';
import type { UserRole } from '@sgr-registry/contracts';
import { ForbiddenFieldError } from './errors';

export type DeadlineField = 'plannedDeadline' | 'claimDeadline' | 'thirdPartyDeadline';

const DEADLINE_CAPABILITY: Record<DeadlineField, Capability> = {
  plannedDeadline: 'EDIT_PLANNED_DEADLINE',
  claimDeadline: 'EDIT_CLAIM_DEADLINE',
  thirdPartyDeadline: 'EDIT_THIRD_PARTY_DEADLINE',
};

export function deadlineFieldsForRole(role: UserRole): DeadlineField[] {
  return (Object.keys(DEADLINE_CAPABILITY) as DeadlineField[]).filter((field) =>
    hasCapability(role, DEADLINE_CAPABILITY[field]),
  );
}

export function assertDeadlineFieldAllowed(role: UserRole, field: DeadlineField): void {
  if (!hasCapability(role, DEADLINE_CAPABILITY[field])) {
    throw new ForbiddenFieldError(field);
  }
}

export function calendarDatesEqual(left: string | null, right: string | null): boolean {
  return left === right;
}

export function isLaterCalendarDate(next: string | null, previous: string | null): boolean {
  if (!next || !previous) {
    return false;
  }
  return next > previous;
}

export function deadlineChangeRequiresReason(input: {
  previous: string | null;
  next: string | null;
}): boolean {
  if (input.previous === null && input.next !== null) {
    return false;
  }
  return input.previous !== input.next;
}
