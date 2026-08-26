import { ACT_FORM_DISPLAY, type ActFormCode } from '@sgr-registry/contracts';
import { ActNumberImmutableError } from './errors';

export const ACT_NUMBER_STRATEGY = 'per-form-year-sequence-table' as const;

export interface ActNumberSequenceKey {
  formCode: ActFormCode;
  year: number;
}

export interface AllocatedActNumber {
  formCode: ActFormCode;
  year: number;
  sequence: number;
  officialNumber: string;
}

/**
 * Formats the official displayed number. Internal form codes stay Latin (S1/S23)
 * to avoid encoding issues; the official number uses Cyrillic С-1 / С-23.
 */
export function formatOfficialActNumber(
  formCode: ActFormCode,
  year: number,
  sequence: number,
): string {
  const label = ACT_FORM_DISPLAY[formCode].officialLabel;
  return `${label}-${year}-${String(sequence).padStart(6, '0')}`;
}

export function calendarYearFromDate(date: Date): number {
  return date.getUTCFullYear();
}

/**
 * Allocates the next number from a stored sequence, not from COUNT(*) + 1.
 * `lastIssued` is the last value already given out for this form+year.
 */
export function nextSequenceFromLastIssued(lastIssued: number | null): number {
  if (lastIssued === null) {
    return 1;
  }
  return lastIssued + 1;
}

export function allocateActNumber(params: {
  formCode: ActFormCode;
  year: number;
  lastIssued: number | null;
}): AllocatedActNumber {
  const sequence = nextSequenceFromLastIssued(params.lastIssued);
  return {
    formCode: params.formCode,
    year: params.year,
    sequence,
    officialNumber: formatOfficialActNumber(params.formCode, params.year, sequence),
  };
}

export function assertActNumberImmutable(
  currentOfficialNumber: string,
  proposedOfficialNumber: string,
): void {
  if (currentOfficialNumber !== proposedOfficialNumber) {
    throw new ActNumberImmutableError();
  }
}

export function usesCountPlusOneStrategy(): false {
  return false;
}
