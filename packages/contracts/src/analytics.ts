import { z } from 'zod';
import { DEFECT_ITEM_STATUSES } from './enums';

export const FINANCIAL_AMOUNT_TYPES = [
  'ESTIMATE',
  'APPROVED_AMOUNT',
  'ACTUAL_COST',
  'RECOVERY',
  'AVOIDED_LOSS',
] as const;
export type FinancialAmountType = (typeof FINANCIAL_AMOUNT_TYPES)[number];

export const FINANCIAL_PAYER_TYPES = [
  'COMPANY',
  'LIABLE_ORGANIZATION',
  'CUSTOMER',
  'OTHER',
] as const;
export type FinancialPayerType = (typeof FINANCIAL_PAYER_TYPES)[number];

export const FINANCIAL_RECORD_STATUSES = ['DRAFT', 'CONFIRMED', 'VOIDED'] as const;
export type FinancialRecordStatus = (typeof FINANCIAL_RECORD_STATUSES)[number];

export const INSPECTION_ATTEMPT_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED'] as const;
export type InspectionAttemptStatus = (typeof INSPECTION_ATTEMPT_STATUSES)[number];

export const ANALYTICS_INSIGHT_STATUSES = [
  'NEW',
  'UNDER_REVIEW',
  'CONFIRMED',
  'DISMISSED',
] as const;
export type AnalyticsInsightStatus = (typeof ANALYTICS_INSIGHT_STATUSES)[number];

export const ANALYTICS_TABS = [
  'overview',
  'costs',
  'liability',
  'process',
  'patterns',
  'data-quality',
  'drilldown',
] as const;

export const analyticsQuerySchema = z
  .object({
    tab: z.enum(ANALYTICS_TABS).optional(),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    propertyObjectId: z.uuid().optional(),
    customerOrganizationId: z.uuid().optional(),
    liableOrganizationId: z.uuid().optional(),
    workTypeId: z.uuid().optional(),
    defectTypeId: z.uuid().optional(),
    status: z.enum(DEFECT_ITEM_STATUSES).optional(),
    deadlineState: z
      .enum(['NO_DEADLINE', 'NORMAL', 'WARNING', 'DUE_TODAY', 'OVERDUE', 'COMPLETED'])
      .optional(),
    source: z.enum(['imported', 'manual']).optional(),
    importedOnly: z.enum(['true', 'false']).optional(),
    attemptResult: z.enum(INSPECTION_ATTEMPT_STATUSES).optional(),
    metric: z
      .enum([
        'defects',
        'acts',
        'openDefects',
        'overdueDefects',
        'noResponsible',
        'noLiableOrganization',
        'noMovement',
        'closedInPeriod',
        'companyActualCost',
        'liableActualCost',
        'recovery',
        'avoidedLoss',
        'reworkCost',
        'firstTimeRight',
        'rework',
        'withAttempts',
        'withoutAttempts',
        'confirmedExposure',
        'riskWeightedBacklog',
      ])
      .optional(),
    page: z.coerce.number().int().positive().max(10_000).optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
  })
  .strict();

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export const financialImpactWriteSchema = z
  .object({
    amountType: z.enum(FINANCIAL_AMOUNT_TYPES),
    payerType: z.enum(FINANCIAL_PAYER_TYPES),
    payerOrganizationId: z.uuid().nullable().optional(),
    amountOriginal: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
    currency: z.string().regex(/^[A-Za-z]{3}$/),
    exchangeRateToByn: z
      .string()
      .regex(/^\d+(\.\d{1,6})?$/)
      .nullable()
      .optional(),
    occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    comment: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export type FinancialImpactWrite = z.infer<typeof financialImpactWriteSchema>;

export const insightReviewSchema = z
  .object({
    status: z.enum(['UNDER_REVIEW', 'CONFIRMED', 'DISMISSED']),
    comment: z.string().trim().min(1).max(2000),
  })
  .strict();

export type InsightReview = z.infer<typeof insightReviewSchema>;

export const supportDrilldownSchema = z
  .object({
    page: z.coerce.number().int().positive().max(10_000).optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
    sort: z.enum(['createdAt', 'status', 'actNumber']).optional(),
    direction: z.enum(['asc', 'desc']).optional(),
  })
  .strict();

export type SupportDrilldownQuery = z.infer<typeof supportDrilldownSchema>;

export interface AnalyticsDuration {
  median: number | null;
  p75: number | null;
  p90: number | null;
  minimum: number | null;
  maximum: number | null;
  mean: number | null;
  sampleSize: number;
  populationSize: number;
  coverage: number | null;
}

export interface AnalyticsRate {
  numerator: number;
  denominator: number;
  rate: number | null;
  coverageText: string | null;
}

export interface AnalyticsOverview {
  filters: AnalyticsQuery;
  acts: number;
  defects: number;
  openDefects: number;
  overdueDefects: number;
  noResponsible: number;
  noLiableOrganization: number;
  noMovement: number;
  closedInPeriod: number;
  companyActualCostByn?: string | null;
  confirmedFinancialExposure?: {
    available: boolean;
    currency: 'BYN';
    grossCompanyCostByn?: string;
    confirmedRecoveryByn?: string;
    netConfirmedExposureByn?: string;
    recordCount: number;
    periodFrom: string | null;
    periodTo: string | null;
  };
  riskWeightedOpenBacklog?: {
    available: boolean;
    weightedByn: string | null;
    unweightedByn: string | null;
    evaluatedDefects: number;
    openDefects: number;
    monetaryCoverage: number | null;
    formulaVersion: string;
    calculatedAt: string;
    inspectionWaitDays: number;
  };
  medianClosureMs: number | null;
  p90ClosureMs: number | null;
  closureSampleSize: number;
  firstTimeRight: AnalyticsRate;
  averageAttempts: number | null;
  newInsights: number;
  openedClosed: Array<{ period: string; opened: number; closed: number }>;
  backlogAge: Array<{ bucket: string; count: number }>;
  topRisks: Array<{ defectItemId: string; actId: string; label: string; score: string }>;
  topOrganizations?: Array<{ organizationId: string; name: string; amountByn: string }>;
  financialVisible: boolean;
  crossOrganizationVisible: boolean;
  canReviewInsights: boolean;
}

export interface AnalyticsCosts {
  companyActualCostByn: string | null;
  liableActualCostByn: string | null;
  recoveryByn: string | null;
  avoidedLossByn: string | null;
  reworkCostByn: string | null;
  meanDefectCostByn: string | null;
  medianDefectCostByn: string | null;
  costSampleSize: number;
  byPeriod: Array<{ period: string; amountByn: string }>;
  byObject: Array<{ id: string; label: string; amountByn: string }>;
  byOrganization: Array<{ id: string; label: string; amountByn: string }>;
  byDefectType: Array<{ id: string; label: string; amountByn: string }>;
  records: Array<{
    id: string;
    defectItemId: string;
    actId: string;
    amountType: string;
    payerType: string;
    amountByn: string;
    occurredAt: string;
    status: string;
  }>;
}

export interface AnalyticsLiabilityRow {
  organizationId: string;
  name: string;
  defects: number;
  share: number | null;
  shareLabel: string;
  firstTimeRight: number | null;
  reworkRate: number | null;
  medianResolutionMs: number | null;
  overdueShare: number | null;
  confirmedCostByn: string | null;
  sampleSize: number;
  coverage: number | null;
  index: number | null;
  ranked: boolean;
  components: Array<{ key: string; label: string; score: number | null; included: boolean }>;
}

export interface AnalyticsLiability {
  rows: AnalyticsLiabilityRow[];
  minimumSample: number;
}

export interface AnalyticsProcess {
  funnel: Array<{ status: string; label: string; count: number }>;
  contractor: AnalyticsDuration;
  inspection: AnalyticsDuration;
  rework: AnalyticsDuration;
  total: AnalyticsDuration;
  detectionToAssignment: AnalyticsDuration;
  assignmentToWorkStart: AnalyticsDuration;
  noMovement: number;
  aging: Array<{ bucket: string; count: number }>;
  inspectionLabel: string;
}

export interface AnalyticsPatternCard {
  id: string;
  signalType: string;
  title: string;
  plainLanguageExplanation: string;
  dimensions: Array<{ key: string; value: string; label: string }>;
  supportCount: number;
  totalCount: number;
  observedValue: number;
  baselineValue: number;
  lift: number | null;
  confidence: string;
  sampleCoverage: number | null;
  periodFrom: string | null;
  periodTo: string | null;
  generatedAt: string;
  ruleVersion: string;
  status: string;
  displayLabel: string;
  statisticallyStable: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  canReview: boolean;
  supportAvailable: boolean;
}

export interface AnalyticsSupportDrilldown {
  insightId: string;
  supportAvailable: boolean;
  unavailableReason: string | null;
  signalType: string | null;
  title: string | null;
  ruleVersion: string | null;
  observedAt: string | null;
  dimensions: Array<{ key: string; value: string; label: string }>;
  supportCount: number;
  page: number;
  pageSize: number;
  sort: string;
  direction: string;
  items: Array<{
    defectItemId: string;
    label: string;
    actId: string;
    actNumber: string | null;
    objectName: string;
    defectType: string;
    workType: string | null;
    liableOrganizations: string[];
    status: string;
    deadline: string | null;
    attemptCount: number;
    contributionReason: string | null;
  }>;
}

export interface AnalyticsPatterns {
  items: AnalyticsPatternCard[];
}

export interface AnalyticsDataQuality {
  missingDefectType: number;
  missingWorkType: number;
  missingLiableOrganization: number;
  missingResponsible: number;
  missingDeadline: number;
  missingAttemptHistory: number;
  missingFinancialData: number;
  unresolvedEngineers: number;
  importedRecords: number;
  incompleteTimestamps: number;
  unavailableDimensions: string[];
  unavailableMetrics: Array<{ metric: string; reason: string }>;
  workExposureRecords: number;
  coverage: Array<{
    metric: string;
    label: string;
    covered: number;
    total: number;
    rate: number | null;
  }>;
  defects: number;
}

export interface AnalyticsDrilldown {
  metric: string;
  total: number;
  page: number;
  pageSize: number;
  filters: AnalyticsQuery;
  items: Array<{
    defectItemId: string | null;
    actId: string;
    actNumber: string | null;
    objectName: string;
    liableOrganizations: string[];
    status: string;
    createdAt: string;
    contribution: string | null;
  }>;
}

export interface AnalyticsFilterOptions {
  objects: Array<{ id: string; label: string }>;
  customers: Array<{ id: string; label: string }>;
  liableOrganizations: Array<{ id: string; label: string }>;
  workTypes: Array<{ id: string; label: string }>;
  defectTypes: Array<{ id: string; label: string }>;
  severityAvailable: false;
}

export interface FinancialImpactItem {
  id: string;
  defectItemId: string;
  amountType: string;
  payerType: string;
  payerOrganizationId: string | null;
  amountOriginal: string;
  currency: string;
  exchangeRateToByn: string;
  amountByn: string;
  occurredAt: string;
  status: string;
  source: string;
  comment: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface FinancialImpactList {
  confirmedCompanyCostByn: string | null;
  headline: string;
  canManage: boolean;
  items: FinancialImpactItem[];
}
