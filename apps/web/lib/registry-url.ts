import {
  countActiveRegistryFilters,
  parseRegistryListQuery,
  serializeRegistryQuery,
  type RegistryListQuery,
} from '@sgr-registry/domain';

export function queryFromSearchParams(params: URLSearchParams): RegistryListQuery {
  const raw: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key === 'defect') {
      return;
    }
    raw[key] = value;
  });
  return parseRegistryListQuery(raw);
}

export function searchParamsFromQuery(query: RegistryListQuery): string {
  return new URLSearchParams(serializeRegistryQuery(query)).toString();
}

export function withPageReset(query: RegistryListQuery): RegistryListQuery {
  return { ...query, page: 1 };
}

export function activeFilterCount(query: RegistryListQuery): number {
  return countActiveRegistryFilters(query);
}

export function formatCalendarDate(value: string | null): string {
  if (!value) {
    return '—';
  }
  const [year, month, day] = value.split('-');
  if (!year || !month || !day) {
    return value;
  }
  return `${day}.${month}.${year}`;
}

export function formatTimestamp(value: string | null): string {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return new Intl.DateTimeFormat('ru-BY', {
    timeZone: 'Europe/Minsk',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function isSafeDocumentHref(value: string | null): value is string {
  return Boolean(value && /^https?:\/\//i.test(value));
}
