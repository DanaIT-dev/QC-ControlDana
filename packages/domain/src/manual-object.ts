import { DuplicateValueError, ValidationError } from './errors';
import { parseOptionalCalendarDate } from './reference';
import { foldKey, normalizeOptionalText, normalizeRequiredText } from './text';

export const MANUAL_OBJECT_SOURCE_SYSTEM = 'MANUAL';
export const PROPERTY_OBJECT_NAME_MAX = 200;
export const PROPERTY_OBJECT_ADDRESS_MAX = 300;
export const PROPERTY_OBJECT_ENGINEER_NAME_MAX = 100;

export interface ManualObjectInput {
  name: string;
  address: string | null;
  commissionedAt: string | null;
  warrantyEndsAt: string | null;
  responsibleEngineerId: string | null;
  responsibleEngineerName: string | null;
}

export function parseManualObjectInput(raw: {
  name: string;
  address?: string | null;
  commissionedAt?: string | null;
  warrantyEndsAt?: string | null;
  responsibleEngineerId?: string | null;
  responsibleEngineerName?: string | null;
}): ManualObjectInput {
  const name = normalizeRequiredText(raw.name, 'name', PROPERTY_OBJECT_NAME_MAX);
  const address = normalizeOptionalText(raw.address, 'address', PROPERTY_OBJECT_ADDRESS_MAX);
  const commissionedAt = parseOptionalCalendarDate(raw.commissionedAt, 'commissionedAt');
  const warrantyEndsAt = parseOptionalCalendarDate(raw.warrantyEndsAt, 'warrantyEndsAt');
  if (commissionedAt && warrantyEndsAt && warrantyEndsAt < commissionedAt) {
    throw new ValidationError(
      'warrantyEndsAt',
      'Дата окончания гарантии не может быть раньше даты приёмки',
    );
  }
  return {
    name,
    address,
    commissionedAt,
    warrantyEndsAt,
    responsibleEngineerId: raw.responsibleEngineerId ?? null,
    responsibleEngineerName: normalizeOptionalText(
      raw.responsibleEngineerName,
      'responsibleEngineerName',
      PROPERTY_OBJECT_ENGINEER_NAME_MAX,
    ),
  };
}

export function assertManualObjectNotDuplicate(
  candidate: { name: string; address: string | null },
  existing: ReadonlyArray<{ name: string; address: string | null }>,
): void {
  const nameKey = foldKey(candidate.name);
  const addressKey = foldKey(candidate.address ?? '');
  const duplicate = existing.some(
    (row) => foldKey(row.name) === nameKey && foldKey(row.address ?? '') === addressKey,
  );
  if (duplicate) {
    throw new DuplicateValueError('Объект с таким названием и адресом уже существует');
  }
}
