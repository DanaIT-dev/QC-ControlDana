import type { RegistryFilterOption } from '@sgr-registry/contracts';
import { ACT_STATUS_LABELS, DEADLINE_STATE_LABELS } from '@sgr-registry/domain';
import type { RegistryListQuery } from '@sgr-registry/domain';

export interface FilterChip {
  id: string;
  label: string;
  onRemoveQuery: Partial<RegistryListQuery>;
}

export interface RegistryFilterOptions {
  formCodes: RegistryFilterOption[];
  statuses: RegistryFilterOption[];
  objects: RegistryFilterOption[];
  defectTypes: RegistryFilterOption[];
  customers: RegistryFilterOption[];
  liableOrganizations: RegistryFilterOption[];
  responsibleEngineers: RegistryFilterOption[];
}

function chipForList(
  key: string,
  title: string,
  values: string[],
  options: RegistryFilterOption[],
  clear: Partial<RegistryListQuery>,
): FilterChip | null {
  if (values.length === 0) {
    return null;
  }
  if (values.length === 1) {
    const match = options.find((option) => option.id === values[0]);
    return {
      id: key,
      label: `${title}: ${match?.label ?? values[0]}`,
      onRemoveQuery: clear,
    };
  }
  return {
    id: key,
    label: `${title}: ${values.length}`,
    onRemoveQuery: clear,
  };
}

function chipForRange(
  key: string,
  title: string,
  from: string | null,
  to: string | null,
  clear: Partial<RegistryListQuery>,
): FilterChip | null {
  if (!from && !to) {
    return null;
  }
  const range = [from ?? '…', to ?? '…'].join(' — ');
  return { id: key, label: `${title}: ${range}`, onRemoveQuery: clear };
}

export function buildRegistryFilterChips(
  query: RegistryListQuery,
  options: RegistryFilterOptions | null,
): FilterChip[] {
  const chips: Array<FilterChip | null> = [
    query.search
      ? {
          id: 'search',
          label: `Поиск: ${query.search}`,
          onRemoveQuery: { search: null },
        }
      : null,
    chipForList('formCodes', 'Форма', query.formCodes, options?.formCodes ?? [], {
      formCodes: [],
    }),
    chipForList(
      'statuses',
      'Статус',
      query.statuses,
      query.statuses.map((id) => ({
        id,
        label: ACT_STATUS_LABELS[id] ?? id,
      })),
      { statuses: [] },
    ),
    chipForList('objectIds', 'Объект', query.objectIds, options?.objects ?? [], {
      objectIds: [],
    }),
    chipForList('defectTypeIds', 'Вид дефекта', query.defectTypeIds, options?.defectTypes ?? [], {
      defectTypeIds: [],
    }),
    chipForList(
      'customerOrganizationIds',
      'Заказчик',
      query.customerOrganizationIds,
      options?.customers ?? [],
      { customerOrganizationIds: [] },
    ),
    chipForList(
      'liableOrganizationIds',
      'Виновная организация',
      query.liableOrganizationIds,
      options?.liableOrganizations ?? [],
      { liableOrganizationIds: [] },
    ),
    chipForList(
      'responsibleEngineerIds',
      'Ответственный инженер',
      query.responsibleEngineerIds,
      options?.responsibleEngineers ?? [],
      { responsibleEngineerIds: [] },
    ),
    chipForRange(
      'plannedDeadline',
      'Плановый срок',
      query.plannedDeadlineFrom,
      query.plannedDeadlineTo,
      { plannedDeadlineFrom: null, plannedDeadlineTo: null },
    ),
    chipForRange(
      'claimDeadline',
      'Срок по претензии',
      query.claimDeadlineFrom,
      query.claimDeadlineTo,
      {
        claimDeadlineFrom: null,
        claimDeadlineTo: null,
      },
    ),
    chipForRange('readyAt', 'Дата готовности', query.readyAtFrom, query.readyAtTo, {
      readyAtFrom: null,
      readyAtTo: null,
    }),
    chipForList(
      'deadlineState',
      'Состояние срока',
      query.deadlineState,
      query.deadlineState.map((id) => ({
        id,
        label: DEADLINE_STATE_LABELS[id] ?? id,
      })),
      { deadlineState: [] },
    ),
  ];
  return chips.filter((chip): chip is FilterChip => chip !== null);
}
