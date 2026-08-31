import { foldKey } from './text';

export interface PropertyObjectChoice {
  id: string;
  name: string;
  address: string;
  active?: boolean;
}

export type PropertyObjectSearchField = 'name' | 'address';

export function matchesPropertyObjectQuery(haystack: string, query: string): boolean {
  const needle = foldKey(query);
  if (!needle) {
    return true;
  }
  return foldKey(haystack).includes(needle);
}

export function selectablePropertyObjects(
  items: readonly PropertyObjectChoice[],
): PropertyObjectChoice[] {
  return items.filter((item) => item.active !== false);
}

export function filterPropertyObjects(
  items: readonly PropertyObjectChoice[],
  query: string,
  field: PropertyObjectSearchField,
): PropertyObjectChoice[] {
  return selectablePropertyObjects(items).filter((item) =>
    matchesPropertyObjectQuery(field === 'name' ? item.name : item.address, query),
  );
}

export function propertyObjectById(
  items: readonly PropertyObjectChoice[],
  id: string | null | undefined,
): PropertyObjectChoice | null {
  if (!id) {
    return null;
  }
  return items.find((item) => item.id === id) ?? null;
}
