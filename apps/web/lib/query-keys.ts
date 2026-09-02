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
  attachments: (path: string) => ['attachments', path] as const,
  actChat: (actId: string) => ['act-chat', actId] as const,
  actChatMentions: (actId: string, q: string) => ['act-chat-mentions', actId, q] as const,
  notifications: {
    all: ['notifications'] as const,
    unread: ['notifications', 'unread'] as const,
    preview: ['notifications', 'preview'] as const,
    list: (filter: string, page: number) => ['notifications', 'list', filter, page] as const,
  },
  sla: {
    all: ['sla'] as const,
    summary: ['sla', 'summary'] as const,
    items: (query: string) => ['sla', 'items', query] as const,
  },
  notificationSettings: ['notification-settings'] as const,
  registry: {
    all: ['registry'] as const,
    defects: (query: unknown) => ['registry', 'defects', query] as const,
    summary: (query: unknown) => ['registry', 'summary', query] as const,
    filterOptions: ['registry', 'filter-options'] as const,
  },
  objects: {
    all: ['objects'] as const,
    list: (query: unknown) => ['objects', 'list', query] as const,
  },
} as const;
