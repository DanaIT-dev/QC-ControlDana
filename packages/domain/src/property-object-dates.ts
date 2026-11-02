import { ValidationError } from './errors';
import { parseOptionalCalendarDate } from './reference';

export interface PropertyObjectDateUpdate {
  commissionedAt: string | null;
  setCommissionedAt: boolean;
  warrantyEndsAt: string | null;
  setWarrantyEndsAt: boolean;
}

/**
 * Calendar dates on an existing object.
 * Omitted fields stay unchanged. An explicit null clears the date.
 * The same calendar day is not rewritten, so a different time-of-day in storage
 * and an unchanged historical pair are left alone.
 * Warranty may precede acceptance only when that pair is not being changed.
 */
export function resolvePropertyObjectDateUpdate(input: {
  currentCommissionedAt: string | null;
  currentWarrantyEndsAt: string | null;
  commissionedAt?: string | null;
  warrantyEndsAt?: string | null;
}): PropertyObjectDateUpdate {
  const commissioned = nextCalendarDate(
    input.currentCommissionedAt,
    input.commissionedAt,
    'commissionedAt',
  );
  const warranty = nextCalendarDate(
    input.currentWarrantyEndsAt,
    input.warrantyEndsAt,
    'warrantyEndsAt',
  );
  if (
    (commissioned.set || warranty.set) &&
    commissioned.value &&
    warranty.value &&
    warranty.value < commissioned.value
  ) {
    throw new ValidationError(
      'warrantyEndsAt',
      'Дата окончания гарантии не может быть раньше даты приёмки',
    );
  }
  return {
    commissionedAt: commissioned.value,
    setCommissionedAt: commissioned.set,
    warrantyEndsAt: warranty.value,
    setWarrantyEndsAt: warranty.set,
  };
}

function nextCalendarDate(
  current: string | null,
  incoming: string | null | undefined,
  field: string,
): { value: string | null; set: boolean } {
  if (incoming === undefined) {
    return { value: current, set: false };
  }
  const parsed = parseOptionalCalendarDate(incoming, field);
  if (parsed === current) {
    return { value: current, set: false };
  }
  return { value: parsed, set: true };
}
