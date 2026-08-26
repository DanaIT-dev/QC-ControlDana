import type {
  ActDetailResponse,
  RegistryFilterOptionsResponse,
  RegistryListResponse,
  RegistrySummaryResponse,
} from '@sgr-registry/contracts';
import type { RegistryListQuery } from '@sgr-registry/domain';
import { serializeRegistryQuery } from '@sgr-registry/domain';

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status}`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

function queryString(query: RegistryListQuery): string {
  const params = new URLSearchParams(serializeRegistryQuery(query));
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

export function fetchRegistryList(query: RegistryListQuery): Promise<RegistryListResponse> {
  return getJson(`/api/registry/defects${queryString(query)}`);
}

export function fetchRegistrySummary(query: RegistryListQuery): Promise<RegistrySummaryResponse> {
  return getJson(`/api/registry/summary${queryString(query)}`);
}

export function fetchRegistryFilterOptions(): Promise<RegistryFilterOptionsResponse> {
  return getJson('/api/registry/filter-options');
}

export function fetchActDetail(actId: string): Promise<ActDetailResponse> {
  return getJson(`/api/acts/${actId}`);
}
