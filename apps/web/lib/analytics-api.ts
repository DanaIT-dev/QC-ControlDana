import type {
  AnalyticsCosts,
  AnalyticsDataQuality,
  AnalyticsDrilldown,
  AnalyticsFilterOptions,
  AnalyticsLiability,
  AnalyticsOverview,
  AnalyticsPatterns,
  AnalyticsProcess,
  FinancialImpactList,
} from '@sgr-registry/contracts';
import { commandFetch } from './command-api';

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) {
    const error = new Error('Не удалось загрузить аналитику') as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

export function fetchAnalyticsOverview(search: string) {
  return getJson<AnalyticsOverview>(`/api/analytics/overview${search}`);
}

export function fetchAnalyticsCosts(search: string) {
  return getJson<AnalyticsCosts>(`/api/analytics/costs${search}`);
}

export function fetchAnalyticsLiability(search: string) {
  return getJson<AnalyticsLiability>(`/api/analytics/liability${search}`);
}

export function fetchAnalyticsProcess(search: string) {
  return getJson<AnalyticsProcess>(`/api/analytics/process${search}`);
}

export function fetchAnalyticsPatterns(search: string) {
  return getJson<AnalyticsPatterns>(`/api/analytics/patterns${search}`);
}

export function fetchAnalyticsDataQuality(search: string) {
  return getJson<AnalyticsDataQuality>(`/api/analytics/data-quality${search}`);
}

export function fetchAnalyticsDrilldown(search: string) {
  return getJson<AnalyticsDrilldown>(`/api/analytics/drilldown${search}`);
}

export function fetchAnalyticsFilters(search: string) {
  return getJson<AnalyticsFilterOptions>(`/api/analytics/filters${search}`);
}

export function fetchFinancialImpacts(defectItemId: string) {
  return getJson<FinancialImpactList>(`/api/defects/${defectItemId}/financials`);
}

export function createFinancialImpact(
  defectItemId: string,
  csrfToken: string,
  body: Record<string, unknown>,
) {
  return commandFetch(`/api/defects/${defectItemId}/financials`, {
    method: 'POST',
    csrfToken,
    body,
  });
}

export function reviewInsight(
  id: string,
  csrfToken: string,
  body: { status: string; comment: string },
) {
  return commandFetch(`/api/analytics/insights/${id}/review`, {
    method: 'POST',
    csrfToken,
    body,
  });
}
