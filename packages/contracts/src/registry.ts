import type { ActFormCode, ActStatus, DefectItemStatus, ProposalSlot } from './enums';
import type { DeadlineState } from './enums';

export interface RegistryProposalDto {
  id?: string;
  slot: ProposalSlot;
  amount: string;
  currency: string;
  contractorName: string;
  organizationId?: string;
  version?: number;
  status?: 'ACTIVE' | 'ARCHIVED';
}

export interface RegistryDefectRow {
  rowId: string;
  defectItemId: string | null;
  actId: string;
  formCode: ActFormCode | null;
  formLabel: string;
  actNumber: string;
  actStatus: ActStatus;
  actStatusLabel: string;
  defectStatus: DefectItemStatus;
  defectStatusLabel: string;
  objectId: string | null;
  objectName: string | null;
  objectAddress: string | null;
  location: string | null;
  sourceDeadlineRaw?: string | null;
  defectTypeId: string | null;
  defectTypeName: string | null;
  customerOrganizationId: string | null;
  customerName: string | null;
  liableOrganizations: Array<{ id: string; name: string }>;
  responsibleEngineers: Array<{
    id: string | null;
    lastName?: string;
    firstName?: string;
    middleName?: string | null;
    fullName: string;
    unmatched?: boolean;
    sourceNameRaw?: string | null;
    referenceId?: string;
  }>;
  plannedDeadline: string | null;
  claimDeadline: string | null;
  effectiveDeadline: string | null;
  deadlineState: DeadlineState;
  deadlineStateLabel: string;
  daysRemaining?: number | null;
  daysRemainingLabel?: string | null;
  deadlineNotice?: string | null;
  deadlineControlActive?: boolean;
  fillState?: 'EMPTY' | 'INCOMPLETE' | 'READY';
  fillLabel?: string;
  assignmentLabel?: string | null;
  readyAt: string | null;
  documentRef: string | null;
  proposalA: RegistryProposalDto | null;
  proposalsBC?: RegistryProposalDto[];
}

export interface RegistryListResponse {
  items: RegistryDefectRow[];
  page: number;
  pageSize: number;
  totalCount: number;
  actCount: number;
  totalPages: number;
  appliedSort: { sortBy: string; sortDirection: string };
}

export interface RegistrySummaryResponse {
  total: number;
  actCount: number;
  newCount: number;
  inProgress: number;
  completed: number;
  warning: number;
  overdue: number;
  noDeadline: number;
  currency: string;
  deadlineWarningDays: number;
  businessDate: string;
  proposalASum?: string;
  unfinishedDrafts: Array<{ id: string; label: string; updatedAt: string }>;
}

export interface RegistryFilterOption {
  id: string;
  label: string;
  title?: string;
}

export interface RegistryFilterOptionsResponse {
  formCodes: RegistryFilterOption[];
  statuses: RegistryFilterOption[];
  objects: RegistryFilterOption[];
  defectTypes: RegistryFilterOption[];
  customers: RegistryFilterOption[];
  liableOrganizations: RegistryFilterOption[];
  responsibleEngineers: RegistryFilterOption[];
}

export interface ActLegacyImportSource {
  sourceActNumberRaw: string | null;
  sourceStatusRaw: string | null;
  sourceDeadlineRaws: string[];
  sourceExternalUrl: string | null;
  sourceRows: number[];
  importedAt: string | null;
}

export interface ActDetailDefectItem {
  id: string;
  location: string | null;
  defectTypeId: string | null;
  defectTypeName: string | null;
  status: DefectItemStatus;
  statusLabel: string;
  version: number;
  claimDetails: string | null;
  sourceDeadlineRaw: string | null;
  responsibleEngineers: Array<{
    id: string | null;
    lastName?: string;
    firstName?: string;
    middleName?: string | null;
    fullName: string;
    unmatched?: boolean;
    sourceNameRaw?: string | null;
    referenceId?: string;
  }>;
  liableOrganizations: Array<{ id: string; name: string }>;
  plannedDeadline: string | null;
  claimDeadline: string | null;
  effectiveDeadline: string | null;
  deadlineState: DeadlineState;
  deadlineStateLabel: string;
  daysRemaining?: number | null;
  daysRemainingLabel?: string | null;
  deadlineNotice?: string | null;
  deadlineControlActive?: boolean;
  readyAt: string | null;
  thirdPartyDeadline: string | null;
  submittedForInspectionAt: string | null;
  submittedByName: string | null;
  submissionComment: string | null;
  rejectedAt: string | null;
  rejectedByName: string | null;
  rejectionReason: string | null;
  acceptedAt: string | null;
  acceptedByName: string | null;
  notes: string | null;
  proposalA: RegistryProposalDto | null;
  proposalsBC?: RegistryProposalDto[];
}

export interface ActDetailResponse {
  id: string;
  formCode: ActFormCode | null;
  formLabel: string;
  officialNumber: string | null;
  status: ActStatus;
  statusLabel: string;
  version: number;
  startedAt: string | null;
  startedBy: {
    id: string;
    lastName?: string;
    firstName?: string;
    middleName?: string | null;
    fullName: string;
  } | null;
  objectId: string | null;
  objectName: string | null;
  objectAddress: string | null;
  draft: boolean;
  fillState?: 'EMPTY' | 'INCOMPLETE' | 'READY';
  fillLabel?: string;
  assignmentLabel?: string | null;
  updatedAt: string;
  fillingEngineer: {
    id: string;
    lastName?: string;
    firstName?: string;
    middleName?: string | null;
    fullName: string;
  } | null;
  commissionedAt: string | null;
  warrantyEndsAt: string | null;
  customerOrganizationId: string | null;
  customerName: string | null;
  issuedOn: string | null;
  signedDocumentRef: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancellationReason: string | null;
  legacyImport: ActLegacyImportSource | null;
  defectItems: ActDetailDefectItem[];
}
