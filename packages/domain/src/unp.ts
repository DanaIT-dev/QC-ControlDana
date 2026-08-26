import { UnpConflictError } from './errors';

/**
 * UNP is normalized by trimming and removing internal whitespace.
 * Empty values become null and never participate in uniqueness.
 */
export function normalizeUnp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.replace(/\s+/g, '').trim();
  return normalized.length === 0 ? null : normalized;
}

export function assertUnpAvailable(
  candidate: string | null | undefined,
  existingNormalizedUnps: readonly (string | null | undefined)[],
): string | null {
  const normalized = normalizeUnp(candidate);
  if (normalized === null) {
    return null;
  }

  const conflict = existingNormalizedUnps.some((item) => normalizeUnp(item) === normalized);
  if (conflict) {
    throw new UnpConflictError();
  }

  return normalized;
}
