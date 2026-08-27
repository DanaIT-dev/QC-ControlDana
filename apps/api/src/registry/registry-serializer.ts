import type { Prisma } from '@sgr-registry/database';
import type { ActFormCode, ActStatus, DefectItemStatus, UserRole } from '@sgr-registry/contracts';
import {
  BUSINESS_TIME_ZONE,
  actStatusLabel,
  calendarDateInTimeZone,
  deadlineStateLabel,
  deadlineStateOf,
  defectItemStatusLabel,
  effectiveDeadlineOf,
  formLabel,
  shapeProposals,
} from '@sgr-registry/domain';

const LIST_SELECT = {
  id: true,
  status: true,
  location: true,
  plannedDeadline: true,
  claimDeadline: true,
  effectiveDeadline: true,
  readyAt: true,
  createdAt: true,
  act: {
    select: {
      id: true,
      officialNumber: true,
      formCode: true,
      signedDocumentRef: true,
      objectId: true,
      customerOrganizationId: true,
      propertyObject: { select: { id: true, name: true, address: true } },
      customer: { select: { id: true, officialName: true } },
    },
  },
  defectType: { select: { id: true, name: true } },
  responsibleEngineers: {
    select: { user: { select: { id: true, fullName: true } } },
    orderBy: { user: { fullName: 'asc' } },
  },
  liableOrganizations: {
    select: { organization: { select: { id: true, officialName: true } } },
    orderBy: { organization: { officialName: 'asc' } },
  },
  proposals: {
    select: {
      id: true,
      slot: true,
      amount: true,
      currency: true,
      alternativeContractor: { select: { officialName: true } },
    },
  },
} satisfies Prisma.DefectItemSelect;

export type RegistryListRecord = Prisma.DefectItemGetPayload<{ select: typeof LIST_SELECT }>;

export const registryListSelect = LIST_SELECT;

export function calendarField(value: Date | null, timeZone = BUSINESS_TIME_ZONE): string | null {
  return value ? calendarDateInTimeZone(value, timeZone) : null;
}

export function timestampField(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toRegistryRow(
  item: RegistryListRecord,
  role: UserRole,
  warningDays: number,
  now: Date,
  timeZone: string,
) {
  const proposals = shapeProposals(
    item.proposals.map((proposal) => ({
      id: proposal.id,
      slot: proposal.slot,
      amount: proposal.amount,
      currency: proposal.currency,
      contractorName: proposal.alternativeContractor.officialName,
    })),
    role,
  );
  const deadlineState = deadlineStateOf({
    status: item.status,
    plannedDeadline: item.plannedDeadline,
    claimDeadline: item.claimDeadline,
    deadlineWarningDays: warningDays,
    now,
    timeZone,
  });
  return {
    rowId: item.id,
    defectItemId: item.id,
    actId: item.act.id,
    formCode: item.act.formCode as ActFormCode,
    formLabel: formLabel(item.act.formCode as ActFormCode),
    actNumber: item.act.officialNumber,
    defectStatus: item.status as DefectItemStatus,
    defectStatusLabel: defectItemStatusLabel(item.status as DefectItemStatus),
    objectId: item.act.objectId,
    objectName: item.act.propertyObject.name,
    objectAddress: item.act.propertyObject.address,
    location: item.location,
    defectTypeId: item.defectType.id,
    defectTypeName: item.defectType.name,
    customerOrganizationId: item.act.customerOrganizationId,
    customerName: item.act.customer.officialName,
    liableOrganizations: item.liableOrganizations.map((entry) => ({
      id: entry.organization.id,
      name: entry.organization.officialName,
    })),
    responsibleEngineers: item.responsibleEngineers.map((entry) => ({
      id: entry.user.id,
      fullName: entry.user.fullName,
    })),
    plannedDeadline: calendarField(item.plannedDeadline, timeZone),
    claimDeadline: calendarField(item.claimDeadline, timeZone),
    effectiveDeadline: calendarField(
      effectiveDeadlineOf({
        plannedDeadline: item.plannedDeadline,
        claimDeadline: item.claimDeadline,
      }),
      timeZone,
    ),
    deadlineState,
    deadlineStateLabel: deadlineStateLabel(deadlineState),
    readyAt: timestampField(item.readyAt),
    documentRef: item.act.signedDocumentRef,
    ...proposals,
  };
}

export function toActHeader(act: {
  id: string;
  formCode: ActFormCode;
  officialNumber: string;
  status: ActStatus;
  version?: number;
  objectId?: string;
  customerOrganizationId?: string;
  issuedOn?: Date | null;
  createdAt: Date;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  signedDocumentRef: string | null;
  propertyObject: {
    name: string;
    address: string;
    commissionedAt: Date | null;
    warrantyEndsAt: Date | null;
  };
  customer: { officialName: string };
}) {
  return {
    id: act.id,
    formCode: act.formCode,
    formLabel: formLabel(act.formCode),
    officialNumber: act.officialNumber,
    status: act.status,
    statusLabel: actStatusLabel(act.status),
    version: act.version ?? 1,
    objectId: act.objectId ?? '',
    objectName: act.propertyObject.name,
    objectAddress: act.propertyObject.address,
    commissionedAt: calendarField(act.propertyObject.commissionedAt),
    warrantyEndsAt: calendarField(act.propertyObject.warrantyEndsAt),
    customerOrganizationId: act.customerOrganizationId ?? '',
    customerName: act.customer.officialName,
    issuedOn: act.issuedOn ? calendarField(act.issuedOn) : null,
    signedDocumentRef: act.signedDocumentRef,
    createdAt: act.createdAt.toISOString(),
    cancelledAt: timestampField(act.cancelledAt),
    cancellationReason: act.cancellationReason,
  };
}
