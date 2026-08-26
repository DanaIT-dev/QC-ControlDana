import type { UserStatus } from '@sgr-registry/contracts';

export interface UserState {
  id: string;
  status: UserStatus;
  archivedAt: Date | null;
}

export interface AssignmentRecord {
  userId: string;
  assignedAt: Date;
  unassignedAt: Date | null;
}

export function archiveUser(user: UserState, now: Date = new Date()): UserState {
  return {
    ...user,
    status: 'ARCHIVED',
    archivedAt: now,
  };
}

export function preserveAssignmentsOnArchive<T extends AssignmentRecord>(
  user: UserState,
  assignments: readonly T[],
): T[] {
  archiveUser(user);
  return assignments.map((assignment) => ({ ...assignment }));
}
