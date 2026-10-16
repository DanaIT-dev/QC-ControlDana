import { ACT_DOCUMENT_MAX_BYTES } from './attachments';
import { ValidationError } from './errors';
import { normalizeOptionalText } from './text';
import { CLAIM_DETAILS_MAX, LOCATION_MAX, NOTES_MAX } from './act-commands';

export const EMPTY_FIELD_LABEL = 'Не заполнено';
export const DRAFT_MARK_LABEL = 'Черновик';

const ACT_DOCUMENT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'] as const;

export function naturalSortKey(value: string): string {
  const source = foldSortText(value);
  let result = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (char >= '0' && char <= '9') {
      let digits = '';
      while (
        index < source.length &&
        (source[index] ?? '') >= '0' &&
        (source[index] ?? '') <= '9'
      ) {
        digits += source[index];
        index += 1;
      }
      result += digits.slice(0, 12).padStart(12, '0');
    } else {
      result += char;
      index += 1;
    }
  }
  return result;
}

export function alphabeticalSortKey(value: string): string {
  return foldSortText(value);
}

export function compareNaturalNames(left: string, right: string): number {
  const byKey = naturalSortKey(left).localeCompare(naturalSortKey(right), 'ru');
  if (byKey !== 0) {
    return byKey;
  }
  return left.localeCompare(right, 'ru');
}

export function compareAlphabeticalNames(left: string, right: string): number {
  const byKey = alphabeticalSortKey(left).localeCompare(alphabeticalSortKey(right), 'ru');
  if (byKey !== 0) {
    return byKey;
  }
  return left.localeCompare(right, 'ru');
}

export function coercePageSize<T extends number>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const text =
    typeof value === 'number' && Number.isInteger(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  if (!/^\d+$/.test(text)) {
    return fallback;
  }
  const parsed = Number(text);
  return (allowed as readonly number[]).includes(parsed) ? (parsed as T) : fallback;
}

export interface DraftDefectFields {
  location?: string | null;
  defectTypeId?: string | null;
  workTypeId?: string | null;
  claimDetails?: string | null;
  notes?: string | null;
  responsibleEngineerIds?: readonly string[] | null;
  liableOrganizationIds?: readonly string[] | null;
  plannedDeadline?: string | null;
  claimDeadline?: string | null;
  thirdPartyDeadline?: string | null;
}

export function isBlankDraftDefect(input: DraftDefectFields): boolean {
  const texts = [input.location, input.claimDetails, input.notes].every(
    (value) => typeof value !== 'string' || value.trim().length === 0,
  );
  const refs = !present(input.defectTypeId) && !present(input.workTypeId);
  const people =
    (input.responsibleEngineerIds?.length ?? 0) === 0 &&
    (input.liableOrganizationIds?.length ?? 0) === 0;
  const dates =
    !present(input.plannedDeadline) &&
    !present(input.claimDeadline) &&
    !present(input.thirdPartyDeadline);
  return texts && refs && people && dates;
}

export function optionalDraftText(value: unknown, field: string, maxLength: number): string | null {
  return normalizeOptionalText(value, field, maxLength);
}

export function normalizeDraftLocation(value: unknown): string | null {
  return optionalDraftText(value, 'location', LOCATION_MAX);
}

export function normalizeDraftClaimDetails(value: unknown): string | null {
  return optionalDraftText(value, 'claimDetails', CLAIM_DETAILS_MAX);
}

export function normalizeDraftNotes(value: unknown): string | null {
  return optionalDraftText(value, 'notes', NOTES_MAX);
}

export function singleResponsibleEngineerId(
  ids: readonly string[] | null | undefined,
  explicit: string | null | undefined,
): string | null {
  if (explicit === null) {
    return null;
  }
  const fromList = (ids ?? []).filter((id) => id.trim().length > 0);
  if (fromList.length > 1) {
    throw new ValidationError(
      'responsibleEngineerIds',
      'У дефекта может быть только один ответственный инженер',
    );
  }
  const chosen = explicit ?? fromList[0] ?? null;
  if (chosen && fromList[0] && chosen !== fromList[0]) {
    throw new ValidationError('responsibleEngineerId', 'Укажите одного ответственного инженера');
  }
  return chosen;
}

export function draftStartGaps(input: {
  objectId: string | null;
  customerOrganizationId: string | null;
  issuedOn: Date | string | null;
  formCode: string | null;
  defects: ReadonlyArray<{ defectTypeId: string | null }>;
}): string[] {
  const gaps: string[] = [];
  if (!input.objectId) {
    gaps.push('объект');
  }
  if (!input.customerOrganizationId) {
    gaps.push('заказчик');
  }
  if (!input.issuedOn) {
    gaps.push('дата акта');
  }
  if (!input.formCode) {
    gaps.push('форма акта');
  }
  if (input.defects.length === 0) {
    gaps.push('хотя бы один дефект');
  }
  if (input.defects.some((item) => !item.defectTypeId)) {
    gaps.push('вид дефекта у каждого дефекта');
  }
  return gaps;
}

export function isAllowedActDocumentName(filename: string): boolean {
  const match = filename.toLowerCase().match(/(\.[a-z0-9]+)$/);
  const extension = match?.[1] ?? '';
  return (ACT_DOCUMENT_EXTENSIONS as readonly string[]).includes(extension);
}

export function actDocumentWithinLimit(sizeBytes: number): boolean {
  return sizeBytes > 0 && sizeBytes <= ACT_DOCUMENT_MAX_BYTES;
}

export function addressUsesClipping(className: string): boolean {
  return /\btruncate\b/.test(className) || /\bline-clamp-\d+\b/.test(className);
}

function present(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function foldSortText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .replaceAll('Ё', 'Е')
    .replaceAll('ё', 'е')
    .toLowerCase();
}
