const CLOSED_ACT = new Set(['COMPLETED', 'CANCELLED']);

export function actCompletionSummary(input: {
  actStatus: string;
  defectStatuses: readonly string[];
}): { progress: string | null; hint: string | null } {
  if (input.actStatus === 'CANCELLED') {
    return { progress: null, hint: null };
  }
  const total = input.defectStatuses.length;
  const completed = input.defectStatuses.filter((status) => status === 'COMPLETED').length;
  if (total === 0) {
    return {
      progress: null,
      hint: 'В акте нет дефектов. Завершить акт нельзя, пока не добавлена хотя бы одна позиция.',
    };
  }
  const progress = `Завершено дефектов: ${completed} из ${total}.`;
  if (input.actStatus === 'COMPLETED') {
    return { progress, hint: 'Акт завершён: все его дефекты завершены.' };
  }
  if (input.actStatus === 'IN_PROGRESS') {
    return {
      progress,
      hint: 'Акт будет завершён после завершения всех его дефектов.',
    };
  }
  return { progress, hint: null };
}

export function defectNextStep(input: {
  actStatus: string;
  defectStatus: string;
  hasLiableOrganization: boolean;
}): string | null {
  if (CLOSED_ACT.has(input.actStatus) || input.defectStatus === 'COMPLETED') {
    return null;
  }
  if (input.defectStatus === 'PENDING_INSPECTION') {
    return 'Следующий шаг — принять устранение или вернуть его на доработку. Это могут сделать администратор, руководитель или ответственный инженер.';
  }
  if (input.actStatus === 'NEW' || input.actStatus === 'IMPORTED_UNSPECIFIED') {
    return 'Сначала возьмите акт в работу. После этого дефект можно завершить или передать на проверку.';
  }
  if (input.defectStatus !== 'IN_PROGRESS' || input.actStatus !== 'IN_PROGRESS') {
    return null;
  }
  if (input.hasLiableOrganization) {
    return 'Следующий шаг — передать дефект на проверку. После приёмки акт закроется, когда будут завершены все дефекты.';
  }
  return 'Следующий шаг — завершить дефект. Это могут сделать администратор, руководитель или ответственный инженер. Акт закроется, когда будут завершены все дефекты.';
}
