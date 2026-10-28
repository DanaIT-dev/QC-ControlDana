import type { Prisma } from '@sgr-registry/database';
import type { ActFormCode, ActStatus, DefectItemStatus, UserRole } from '@sgr-registry/contracts';
import {
  BUSINESS_TIME_ZONE,
  actFillLabel,
  actFillState,
  actStatusLabel,
  assignmentLabel,
  calendarDateInTimeZone,
  deadlinePresentation,
  defectItemStatusLabel,
  displayActNumber,
  effectiveDeadlineOf,
  formLabel,
  shapeProposals,
  type ActFillState,
} from '@sgr-registry/domain';

const LIST_SELECT = {
  id: true,
  status: true,
  location: true,
  sourceDeadlineRaw: true,
  plannedDeadline: true,
  claimDeadline: true,
  effectiveDeadline: true,
  readyAt: true,
  createdAt: true,
  act: {
    select: {
      id: true,
      officialNumber: true,
      sourceActNumberRaw: true,
      formCode: true,
      signedDocumentRef: true,
      status: true,
      issuedOn: true,
      startedAt: true,
      objectId: true,
      customerOrganizationId: true,
      propertyObject: { select: { id: true, name: true, address: true } },
      customer: { select: { id: true, officialName: true } },
    },
  },
  defectType: { select: { id: true, name: true } },
  responsibleEngineers: {
    select: {
      user: {
        select: { id: true, lastName: true, firstName: true, middleName: true, fullName: true },
      },
    },
    orderBy: { user: { lastName: 'asc' } },
  },
  importedEngineerReferences: {
    where: { resolutionStatus: 'UNMATCHED' },
    select: { id: true, sourceNameRaw: true },
    orderBy: { sourceNameRaw: 'asc' },
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
  const presentation = deadlinePresentation({
    actStatus: item.act.status as ActStatus,
    startedAt: item.act.startedAt,
    defectStatus: item.status as DefectItemStatus,
    claimDeadline: item.claimDeadline,
    plannedDeadline: item.plannedDeadline,
    deadlineWarningDays: warningDays,
    now,
    timeZone,
  });
  const fillState = actFillState({
    officialNumber: item.act.officialNumber,
    formCode: item.act.formCode,
    objectId: item.act.objectId,
    customerOrganizationId: item.act.customerOrganizationId,
    issuedOn: item.act.issuedOn,
    defects: [
      {
        location: item.location,
        defectTypeId: item.defectType?.id ?? null,
        responsibleCount: item.responsibleEngineers.length,
        liableCount: item.liableOrganizations.length,
        plannedDeadline: item.plannedDeadline ? 'set' : null,
        claimDeadline: item.claimDeadline ? 'set' : null,
      },
    ],
  });
  return {
    rowId: item.id,
    defectItemId: item.id,
    actId: item.act.id,
    formCode: item.act.formCode,
    formLabel: formLabel(item.act.formCode),
    actNumber: displayActNumber({
      officialNumber: item.act.officialNumber,
      sourceActNumberRaw: item.act.sourceActNumberRaw,
    }),
    actStatus: item.act.status as ActStatus,
    actStatusLabel: actStatusLabel(item.act.status as ActStatus),
    defectStatus: item.status as DefectItemStatus,
    defectStatusLabel: defectItemStatusLabel(item.status as DefectItemStatus),
    objectId: item.act.objectId,
    objectName: item.act.propertyObject?.name ?? null,
    objectAddress: item.act.propertyObject?.address ?? null,
    location: item.location,
    sourceDeadlineRaw: item.sourceDeadlineRaw,
    defectTypeId: item.defectType?.id ?? null,
    defectTypeName: item.defectType?.name ?? null,
    customerOrganizationId: item.act.customerOrganizationId,
    customerName: item.act.customer?.officialName ?? null,
    liableOrganizations: item.liableOrganizations.map((entry) => ({
      id: entry.organization.id,
      name: entry.organization.officialName,
    })),
    responsibleEngineers: [
      ...item.responsibleEngineers.map((entry) => ({
        id: entry.user.id,
        lastName: entry.user.lastName,
        firstName: entry.user.firstName,
        middleName: entry.user.middleName,
        fullName: entry.user.fullName,
        unmatched: false,
      })),
      ...item.importedEngineerReferences.map((entry) => ({
        id: null,
        fullName: entry.sourceNameRaw,
        unmatched: true,
        sourceNameRaw: entry.sourceNameRaw,
        referenceId: entry.id,
      })),
    ],
    plannedDeadline: calendarField(item.plannedDeadline, timeZone),
    claimDeadline: calendarField(item.claimDeadline, timeZone),
    effectiveDeadline: calendarField(
      effectiveDeadlineOf({
        plannedDeadline: item.plannedDeadline,
        claimDeadline: item.claimDeadline,
      }),
      timeZone,
    ),
    deadlineState: presentation.deadlineState,
    deadlineStateLabel: presentation.deadlineStateLabel,
    daysRemaining: presentation.daysRemaining,
    daysRemainingLabel: presentation.daysRemainingLabel,
    deadlineNotice: presentation.deadlineNotice,
    deadlineControlActive: presentation.deadlineControlActive,
    fillState,
    fillLabel: actFillLabel(fillState),
    assignmentLabel: assignmentLabel(item.responsibleEngineers.length),
    readyAt: timestampField(item.readyAt),
    documentRef: null,
    ...proposals,
  };
}

export const emptyActSelect = {
  id: true,
  officialNumber: true,
  sourceActNumberRaw: true,
  formCode: true,
  status: true,
  issuedOn: true,
  startedAt: true,
  objectId: true,
  customerOrganizationId: true,
  createdAt: true,
  updatedAt: true,
  signedDocumentRef: true,
  propertyObject: { select: { id: true, name: true, address: true } },
  customer: { select: { id: true, officialName: true } },
} satisfies Prisma.ActSelect;

export type EmptyActRecord = Prisma.ActGetPayload<{ select: typeof emptyActSelect }>;

export function toEmptyRegistryRow(act: EmptyActRecord, role: UserRole) {
  const fillState: ActFillState = actFillState({
    officialNumber: act.officialNumber,
    formCode: act.formCode,
    objectId: act.objectId,
    customerOrganizationId: act.customerOrganizationId,
    issuedOn: act.issuedOn,
    defects: [],
  });
  const proposals = shapeProposals([], role);
  return {
    rowId: `act:${act.id}`,
    defectItemId: null,
    actId: act.id,
    formCode: act.formCode,
    formLabel: formLabel(act.formCode),
    actNumber: displayActNumber({
      officialNumber: act.officialNumber,
      sourceActNumberRaw: act.sourceActNumberRaw,
    }),
    actStatus: act.status as ActStatus,
    actStatusLabel: actStatusLabel(act.status as ActStatus),
    defectStatus: 'IN_PROGRESS' as DefectItemStatus,
    defectStatusLabel: 'Дефект не добавлен',
    objectId: act.objectId,
    objectName: act.propertyObject?.name ?? null,
    objectAddress: act.propertyObject?.address ?? null,
    location: null,
    sourceDeadlineRaw: null,
    defectTypeId: null,
    defectTypeName: null,
    customerOrganizationId: act.customerOrganizationId,
    customerName: act.customer?.officialName ?? null,
    liableOrganizations: [],
    responsibleEngineers: [],
    plannedDeadline: null,
    claimDeadline: null,
    effectiveDeadline: null,
    deadlineState: 'NO_DEADLINE' as const,
    deadlineStateLabel: 'Срок не установлен',
    daysRemaining: null,
    daysRemainingLabel: null,
    deadlineNotice: null,
    deadlineControlActive: false,
    fillState,
    fillLabel: actFillLabel(fillState),
    assignmentLabel: assignmentLabel(0),
    readyAt: null,
    documentRef: null,
    ...proposals,
  };
}

export function toActHeader(act: {
  id: string;
  formCode: ActFormCode | null;
  officialNumber: string | null;
  sourceActNumberRaw?: string | null;
  status: ActStatus;
  version?: number;
  objectId?: string | null;
  customerOrganizationId?: string | null;
  issuedOn?: Date | null;
  createdAt: Date;
  updatedAt?: Date;
  fillingEngineer?: {
    id: string;
    lastName: string;
    firstName: string;
    middleName: string | null;
    fullName: string;
  } | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  signedDocumentRef: string | null;
  startedAt?: Date | null;
  startedBy?: {
    id: string;
    lastName: string;
    firstName: string;
    middleName: string | null;
    fullName: string;
  } | null;
  sourceStatusRaw?: string | null;
  sourceExternalUrl?: string | null;
  sourceRows?: number[];
  importedAt?: Date | null;
  sourceDeadlineRaws?: string[];
  propertyObject: {
    name: string;
    address: string | null;
    commissionedAt: Date | null;
    warrantyEndsAt: Date | null;
  } | null;
  customer: { officialName: string } | null;
}) {
  const draft = act.status === 'NEW';
  return {
    id: act.id,
    formCode: act.formCode,
    formLabel: formLabel(act.formCode),
    officialNumber: act.officialNumber,
    status: act.status,
    statusLabel: actStatusLabel(act.status),
    version: act.version ?? 1,
    objectId: act.objectId ?? null,
    objectName: act.propertyObject?.name ?? null,
    objectAddress: act.propertyObject?.address ?? null,
    draft,
    updatedAt: (act.updatedAt ?? act.createdAt).toISOString(),
    fillingEngineer: act.fillingEngineer
      ? {
          id: act.fillingEngineer.id,
          lastName: act.fillingEngineer.lastName,
          firstName: act.fillingEngineer.firstName,
          middleName: act.fillingEngineer.middleName,
          fullName: act.fillingEngineer.fullName,
        }
      : null,
    commissionedAt: calendarField(act.propertyObject?.commissionedAt ?? null),
    warrantyEndsAt: calendarField(act.propertyObject?.warrantyEndsAt ?? null),
    customerOrganizationId: act.customerOrganizationId ?? null,
    customerName: act.customer?.officialName ?? null,
    issuedOn: act.issuedOn ? calendarField(act.issuedOn) : null,
    signedDocumentRef: null,
    createdAt: act.createdAt.toISOString(),
    startedAt: timestampField(act.startedAt ?? null),
    startedBy: act.startedBy
      ? {
          id: act.startedBy.id,
          lastName: act.startedBy.lastName,
          firstName: act.startedBy.firstName,
          middleName: act.startedBy.middleName,
          fullName: act.startedBy.fullName,
        }
      : null,
    cancelledAt: timestampField(act.cancelledAt),
    cancellationReason: act.cancellationReason,
    legacyImport: act.importedAt
      ? {
          sourceActNumberRaw: act.sourceActNumberRaw ?? null,
          sourceStatusRaw: act.sourceStatusRaw ?? null,
          sourceDeadlineRaws: act.sourceDeadlineRaws ?? [],
          sourceExternalUrl: null,
          sourceRows: act.sourceRows ?? [],
          importedAt: act.importedAt.toISOString(),
        }
      : null,
  };
}
