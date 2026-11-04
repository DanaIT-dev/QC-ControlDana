import type { UserRole } from '@sgr-registry/contracts';

export type ClosureApprovalRoute = 'OBJECT_ENGINEERS' | 'ADMIN_SGR' | 'UNRESOLVED';

export interface ClosureDecisionActor {
  id: string;
  role: UserRole;
}

export function closureDefectFingerprint(
  items: readonly { id: string; version: number; status: string }[],
): string {
  return [...items]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((item) => `${item.id}:${item.version}:${item.status}`)
    .join('|');
}

export function closureApprovalRoute(input: {
  objectId: string | null;
  activeEngineerIds: readonly string[];
}): ClosureApprovalRoute {
  if (!input.objectId) {
    return 'UNRESOLVED';
  }
  return input.activeEngineerIds.length > 0 ? 'OBJECT_ENGINEERS' : 'ADMIN_SGR';
}

export function closureRouteLabel(input: {
  route: ClosureApprovalRoute;
  approverNames: readonly string[];
}): string {
  if (input.route === 'UNRESOLVED') {
    return 'У акта не указан объект, поэтому нельзя определить, кто согласует закрытие.';
  }
  if (input.route === 'OBJECT_ENGINEERS') {
    const names = input.approverNames.filter((name) => name.trim().length > 0).join(', ');
    return names.length > 0
      ? `Согласуют ответственные инженеры объекта: ${names}. Достаточно одного решения.`
      : 'Согласует ответственный инженер объекта. Достаточно одного решения.';
  }
  return 'На объекте нет ответственных инженеров. Запрос подтверждают или отклоняют администратор или руководитель СГР.';
}

export function canDirectCloseActWithoutInspection(input: {
  role: UserRole;
  assignedToObject: boolean;
  pendingRequest: boolean;
}): boolean {
  if (input.role === 'SUPER_ADMIN') {
    return true;
  }
  if (input.pendingRequest) {
    return false;
  }
  if (input.role === 'ADMIN' || input.role === 'SGR_MANAGER') {
    return true;
  }
  return input.role === 'RESPONSIBLE_ENGINEER' && input.assignedToObject;
}

export function canRequestActClosureWithoutInspection(input: {
  role: UserRole;
  canReadAct: boolean;
  assignedToObject: boolean;
  pendingRequest: boolean;
}): boolean {
  return (
    input.role === 'RESPONSIBLE_ENGINEER' &&
    input.canReadAct &&
    !input.assignedToObject &&
    !input.pendingRequest
  );
}

export function canDecideActClosureRequest(input: {
  actor: ClosureDecisionActor;
  initiatorId: string;
  objectId: string | null;
  activeEngineerIds: readonly string[];
}): boolean {
  if (input.actor.id === input.initiatorId) {
    return false;
  }
  if (input.actor.role === 'SUPER_ADMIN') {
    return true;
  }
  if (
    input.actor.role !== 'ADMIN' &&
    input.actor.role !== 'SGR_MANAGER' &&
    input.actor.role !== 'RESPONSIBLE_ENGINEER'
  ) {
    return false;
  }
  const route = closureApprovalRoute({
    objectId: input.objectId,
    activeEngineerIds: input.activeEngineerIds,
  });
  if (route === 'OBJECT_ENGINEERS') {
    return (
      input.actor.role === 'RESPONSIBLE_ENGINEER' &&
      input.activeEngineerIds.includes(input.actor.id)
    );
  }
  if (route === 'ADMIN_SGR') {
    return input.actor.role === 'ADMIN' || input.actor.role === 'SGR_MANAGER';
  }
  return false;
}

export function viewerMayMutateVisibleAct(input: {
  role: UserRole;
  assignedToObject: boolean;
  readsOwnCreatedAct: boolean;
}): boolean {
  if (input.role !== 'RESPONSIBLE_ENGINEER') {
    return true;
  }
  return input.assignedToObject || !input.readsOwnCreatedAct;
}
