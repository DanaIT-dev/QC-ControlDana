import type { ObjectsDirectoryResponse } from '@sgr-registry/contracts';
import { commandFetch } from './command-api';

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status}`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

export function fetchObjectsDirectory(query: {
  search: string;
  responsibleEngineer: string;
  page: number;
  pageSize: number;
}): Promise<ObjectsDirectoryResponse> {
  const params = new URLSearchParams();
  if (query.search) {
    params.set('search', query.search);
  }
  if (query.responsibleEngineer) {
    params.set('responsibleEngineer', query.responsibleEngineer);
  }
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  params.set('sort', 'source');
  return getJson(`/api/objects?${params.toString()}`);
}

export function linkObjectResponsibleEngineer(
  objectId: string,
  userId: string | null,
  csrfToken: string,
): Promise<{ ok: true }> {
  return commandFetch(`/api/objects/${objectId}/responsible-engineer`, {
    method: 'PATCH',
    csrfToken,
    body: { userId },
  });
}

export function createPropertyObject(
  csrfToken: string,
  body: {
    name: string;
    address?: string | null;
    commissionedAt?: string | null;
    warrantyEndsAt?: string | null;
    responsibleEngineerId?: string | null;
    responsibleEngineerName?: string | null;
  },
): Promise<{
  id: string;
  name: string;
  address: string | null;
  commissionedAt: string | null;
  warrantyEndsAt: string | null;
}> {
  return commandFetch('/api/objects', {
    method: 'POST',
    csrfToken,
    body,
  });
}
