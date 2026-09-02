import type { ObjectsDirectoryResponse } from '@sgr-registry/contracts';

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
