import type { AuditLogListResponse } from '@sgr-registry/contracts';

export function fetchAuditLog(search: string): Promise<AuditLogListResponse> {
  const suffix = search.length > 0 ? `?${search}` : '';
  return fetch(`/api/audit-log${suffix}`, { credentials: 'include', cache: 'no-store' }).then(
    async (response) => {
      if (!response.ok) {
        const error = new Error(`Request failed: ${response.status}`) as Error & { status: number };
        error.status = response.status;
        throw error;
      }
      return (await response.json()) as AuditLogListResponse;
    },
  );
}
