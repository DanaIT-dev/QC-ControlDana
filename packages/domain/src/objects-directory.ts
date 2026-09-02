export const OBJECTS_DIRECTORY_PAGE_SIZES = [20, 50] as const;
export const OBJECTS_DIRECTORY_DEFAULT_PAGE_SIZE = 20;
export const OBJECTS_DIRECTORY_MAX_PAGE_SIZE = 50;

export type ObjectsResponsibleEngineerView =
  | {
      id: string;
      fullName: string;
      status: 'ACTIVE' | 'ARCHIVED';
      linked: true;
      accessActive: boolean;
    }
  | {
      fullName: string;
      linked: false;
      linkState: 'UNMATCHED' | 'AMBIGUOUS' | 'INVALID';
    };

export function objectsDirectoryEmptyLabel(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : '—';
}

export function responsibleEngineerNotice(
  engineer: ObjectsResponsibleEngineerView | null | undefined,
): string | null {
  if (!engineer) {
    return null;
  }
  if (engineer.linked) {
    return engineer.accessActive ? null : 'Учетная запись неактивна';
  }
  if (engineer.linkState === 'AMBIGUOUS') {
    return 'Требуется подтверждение администратора';
  }
  return 'Не связан с учетной записью';
}
