export const OBJECTS_DIRECTORY_PAGE_SIZES = [20, 50] as const;
export const OBJECTS_DIRECTORY_DEFAULT_PAGE_SIZE = 20;
export const OBJECTS_DIRECTORY_MAX_PAGE_SIZE = 50;

export function objectsDirectoryEmptyLabel(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : '—';
}
