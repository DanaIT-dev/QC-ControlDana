export function historyKey(actId: string) {
  return ['history', actId] as const;
}

export function actKey(actId: string) {
  return ['act', actId] as const;
}

export function defectItemKey(defectItemId: string) {
  return ['defect', defectItemId] as const;
}

export const queryKeys = {
  lookups: ['lookups'] as const,
  act: actKey,
  defectItem: defectItemKey,
  history: historyKey,
  registry: {
    all: ['registry'] as const,
    defects: (query: unknown) => ['registry', 'defects', query] as const,
    summary: (query: unknown) => ['registry', 'summary', query] as const,
    filterOptions: ['registry', 'filter-options'] as const,
  },
} as const;
