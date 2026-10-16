export function readPageSizePreference(
  key: string,
  allowed: readonly number[],
  fallback: number,
): number {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const raw = window.localStorage.getItem(key);
  const value = Number(raw);
  return (allowed as readonly number[]).includes(value) ? value : fallback;
}

export function writePageSizePreference(key: string, value: number): void {
  window.localStorage.setItem(key, String(value));
}
