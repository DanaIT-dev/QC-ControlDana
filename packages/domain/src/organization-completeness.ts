import type { OrganizationRole } from '@sgr-registry/contracts';
import { DuplicateDirectoryRecordError } from './errors';
import { foldKey } from './text';
import { normalizeUnp } from './unp';

export const ORGANIZATION_DETAIL_FIELDS = [
  'unp',
  'postalAddress',
  'email',
  'phone',
  'contactPerson',
] as const;

export type OrganizationDetailField = (typeof ORGANIZATION_DETAIL_FIELDS)[number];

export const ORGANIZATION_DETAIL_FIELD_LABELS: Record<OrganizationDetailField, string> = {
  unp: 'УНП',
  postalAddress: 'адрес',
  email: 'электронная почта',
  phone: 'телефон',
  contactPerson: 'контактное лицо',
};

export interface OrganizationDetailsInput {
  officialName: string;
  unp?: string | null;
  postalAddress?: string | null;
  email?: string | null;
  phone?: string | null;
  contactPerson?: string | null;
}

export function missingOrganizationDetailFields(
  input: OrganizationDetailsInput,
): OrganizationDetailField[] {
  return ORGANIZATION_DETAIL_FIELDS.filter((field) => {
    const value = input[field];
    return typeof value !== 'string' || value.trim().length === 0;
  });
}

export function organizationDetailsComplete(input: OrganizationDetailsInput): boolean {
  return missingOrganizationDetailFields(input).length === 0;
}

export function organizationIncompleteOccurrenceKey(organizationId: string): string {
  return ['ORGANIZATION_DETAILS_INCOMPLETE', organizationId].join(':');
}

export function organizationIncompleteNotificationBody(input: {
  officialName: string;
  missingFields: readonly OrganizationDetailField[];
  liable?: boolean;
}): string {
  const labels = input.missingFields.map((field) => ORGANIZATION_DETAIL_FIELD_LABELS[field]);
  const listed = labels.length > 0 ? ` Не заполнены: ${labels.join(', ')}.` : '';
  if (input.liable) {
    return `Заполните подробные данные виновной организации «${input.officialName}».${listed}`;
  }
  return `Заполните подробные данные организации «${input.officialName}».${listed}`;
}

export function organizationDirectoryEditHref(organizationId: string): string {
  return `/reference-data?tab=organizations&id=${organizationId}`;
}

export function findDuplicateOrganization(
  candidate: { officialName: string; unp?: string | null },
  existing: ReadonlyArray<{ id: string; officialName: string; unp?: string | null }>,
): { id: string; officialName: string; unp?: string | null } | null {
  const nameKey = foldKey(candidate.officialName);
  const nameMatch = existing.find((item) => foldKey(item.officialName) === nameKey);
  if (nameMatch) {
    return nameMatch;
  }
  const unp = normalizeUnp(candidate.unp);
  if (!unp) {
    return null;
  }
  return existing.find((item) => normalizeUnp(item.unp) === unp) ?? null;
}

export function assertOrganizationNotDuplicate(
  candidate: { officialName: string; unp?: string | null },
  existing: ReadonlyArray<{ id: string; officialName: string; unp?: string | null }>,
): void {
  const duplicate = findDuplicateOrganization(candidate, existing);
  if (!duplicate) {
    return;
  }
  const sameUnp =
    Boolean(normalizeUnp(candidate.unp)) &&
    normalizeUnp(candidate.unp) === normalizeUnp(duplicate.unp);
  throw new DuplicateDirectoryRecordError(
    sameUnp
      ? 'Организация с таким УНП уже существует'
      : 'Организация с таким названием уже существует',
    { id: duplicate.id, label: duplicate.officialName },
  );
}

export function organizationCreateToast(incomplete: boolean): string {
  return incomplete
    ? 'Организация добавлена. Заполните подробные данные в справочнике.'
    : 'Организация добавлена';
}

export function isLiableOrganizationRole(roles: readonly OrganizationRole[] | undefined): boolean {
  return Boolean(roles?.includes('LIABLE_CONTRACTOR'));
}
