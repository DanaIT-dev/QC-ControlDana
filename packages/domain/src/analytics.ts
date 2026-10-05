import { createHash } from 'node:crypto';
import { ValidationError } from './errors';

export const ANALYTICS_TIME_ZONE = 'Europe/Minsk';
export const ANALYTICS_UTC_OFFSET = '+03:00';
export const ANALYTICS_RULE_VERSION = '2026.10.05';
export const ANALYTICS_MIN_SUPPORT = 5;
export const ANALYTICS_MIN_OBJECTS = 2;
export const ANALYTICS_MIN_COVERAGE = 0.6;
export const ANALYTICS_MIN_ORG_SAMPLE = 5;
export const ANALYTICS_WEAK_SUPPORT = 3;
export const ANALYTICS_MAX_RANGE_DAYS = 3660;
export const ANALYTICS_DRILLDOWN_PAGE_SIZE = 50;
export const ANALYTICS_DRILLDOWN_MAX_PAGE_SIZE = 100;
export const ANALYTICS_NO_MOVEMENT_DAYS = 14;
export const ANALYTICS_PATTERN_TEST_COUNT = 13;
export const ANALYTICS_BONFERRONI_Z = 2.9;

export const ANALYTICS_SIGNAL_TYPES = [
  'COST_CONCENTRATION',
  'SLOW_RESOLUTION',
  'HIGH_REWORK',
  'LOW_FIRST_TIME_RIGHT',
  'OVERDUE_CONCENTRATION',
  'REPEATED_DEFECT_ACROSS_OBJECTS',
  'RESPONSIBILITY_CONCENTRATION',
  'INSPECTION_BOTTLENECK',
  'DATA_QUALITY_RISK',
] as const;

export type AnalyticsSignalType = (typeof ANALYTICS_SIGNAL_TYPES)[number];

export const ANALYTICS_METRICS = [
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
] as const;

export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];

const MONEY_SCALE = 2;
const RATE_SCALE = 6;

export function minskDayStart(isoDate: string): Date {
  assertIsoDate(isoDate);
  return new Date(`${isoDate}T00:00:00.000${ANALYTICS_UTC_OFFSET}`);
}

export function minskDayEnd(isoDate: string): Date {
  assertIsoDate(isoDate);
  return new Date(`${isoDate}T23:59:59.999${ANALYTICS_UTC_OFFSET}`);
}

export function assertAnalyticsRange(dateFrom?: string | null, dateTo?: string | null): void {
  if (!dateFrom && !dateTo) {
    return;
  }
  if (dateFrom) {
    assertIsoDate(dateFrom);
  }
  if (dateTo) {
    assertIsoDate(dateTo);
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new ValidationError('dateFrom', 'Дата начала позже даты окончания');
  }
  if (dateFrom && dateTo) {
    const days = (minskDayStart(dateTo).getTime() - minskDayStart(dateFrom).getTime()) / 86_400_000;
    if (days > ANALYTICS_MAX_RANGE_DAYS) {
      throw new ValidationError('dateTo', 'Слишком большой диапазон дат');
    }
  }
}

function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError('date', 'Ожидается календарная дата');
  }
  const [year, month, day] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(year!, month! - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month! - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new ValidationError('date', 'Несуществующая календарная дата');
  }
}

export function quantile(sorted: readonly number[], probability: number): number | null {
  if (sorted.length === 0 || probability < 0 || probability > 1) {
    return null;
  }
  if (sorted.length === 1) {
    return sorted[0] ?? null;
  }
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const low = sorted[lower];
  const high = sorted[upper];
  if (low == null || high == null) {
    return null;
  }
  if (lower === upper) {
    return low;
  }
  return low + (high - low) * (index - lower);
}

export function percentile(values: readonly number[], probability: number): number | null {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return quantile(sorted, probability);
}

export interface DurationStats {
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

export function durationStats(samples: ReadonlyArray<number | null | undefined>): DurationStats {
  const populationSize = samples.length;
  const present = samples.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  const sorted = [...present].sort((a, b) => a - b);
  const sum = present.reduce((total, value) => total + value, 0);
  return {
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    minimum: sorted[0] ?? null,
    maximum: sorted[sorted.length - 1] ?? null,
    mean: present.length === 0 ? null : sum / present.length,
    sampleSize: present.length,
    populationSize,
    coverage: populationSize === 0 ? null : present.length / populationSize,
  };
}

export interface WilsonInterval {
  low: number;
  high: number;
}

export function wilsonInterval(successes: number, total: number, z = 1.96): WilsonInterval | null {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || total <= 0 || successes < 0) {
    return null;
  }
  if (successes > total) {
    return null;
  }
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denominator;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return numerator / denominator;
}

export interface RateWithCoverage {
  numerator: number;
  denominator: number;
  rate: number | null;
  coverageNumerator: number;
  coverageDenominator: number;
  coverage: number | null;
}

export function firstTimeRight(input: {
  completedAcceptedOnFirstAttempt: number;
  completedWithAttempts: number;
  completedDefects: number;
}): RateWithCoverage {
  return {
    numerator: input.completedAcceptedOnFirstAttempt,
    denominator: input.completedWithAttempts,
    rate: ratio(input.completedAcceptedOnFirstAttempt, input.completedWithAttempts),
    coverageNumerator: input.completedWithAttempts,
    coverageDenominator: input.completedDefects,
    coverage: ratio(input.completedWithAttempts, input.completedDefects),
  };
}

export function reworkRate(input: {
  completedWithRejection: number;
  completedWithAttempts: number;
}): { numerator: number; denominator: number; rate: number | null } {
  return {
    numerator: input.completedWithRejection,
    denominator: input.completedWithAttempts,
    rate: ratio(input.completedWithRejection, input.completedWithAttempts),
  };
}

export function formatCoverage(withData: number, total: number, noun = 'дефектов'): string {
  return `${withData} из ${total} ${noun} имеют данные о попытках`;
}

export interface AttemptClockInput {
  attemptNumber: number;
  submittedAt: Date;
  reviewedAt: Date | null;
  previousReviewedAt: Date | null;
  workStartedAt: Date | null;
}

export interface AttemptClock {
  contractorMs: number | null;
  inspectionMs: number | null;
  reworkMs: number | null;
}

export function attemptClock(input: AttemptClockInput, now = new Date()): AttemptClock {
  const start = input.attemptNumber <= 1 ? input.workStartedAt : input.previousReviewedAt;
  const contractorMs =
    start == null ? null : Math.max(0, input.submittedAt.getTime() - start.getTime());
  const inspectionEnd = input.reviewedAt ?? now;
  const inspectionMs = Math.max(0, inspectionEnd.getTime() - input.submittedAt.getTime());
  return {
    contractorMs,
    inspectionMs: input.reviewedAt == null && input.submittedAt > now ? null : inspectionMs,
    reworkMs: input.attemptNumber > 1 ? contractorMs : 0,
  };
}

export function sumNullable(values: ReadonlyArray<number | null>): number | null {
  if (values.length === 0 || values.some((value) => value == null)) {
    return null;
  }
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

export interface FinancialAmountInput {
  amountType: 'ESTIMATE' | 'APPROVED_AMOUNT' | 'ACTUAL_COST' | 'RECOVERY' | 'AVOIDED_LOSS';
  payerType: 'COMPANY' | 'LIABLE_ORGANIZATION' | 'CUSTOMER' | 'OTHER';
  status: 'DRAFT' | 'CONFIRMED' | 'VOIDED';
  amountByn: string;
}

export function isCompanyActualCost(record: FinancialAmountInput): boolean {
  return (
    record.status === 'CONFIRMED' &&
    record.amountType === 'ACTUAL_COST' &&
    record.payerType === 'COMPANY'
  );
}

export function isLiableActualCost(record: FinancialAmountInput): boolean {
  return (
    record.status === 'CONFIRMED' &&
    record.amountType === 'ACTUAL_COST' &&
    record.payerType === 'LIABLE_ORGANIZATION'
  );
}

export function includedFinancialAmount(
  record: FinancialAmountInput,
  kind: 'COMPANY_ACTUAL' | 'LIABLE_ACTUAL' | 'RECOVERY' | 'AVOIDED_LOSS',
): string | null {
  if (record.status !== 'CONFIRMED') {
    return null;
  }
  if (kind === 'COMPANY_ACTUAL' && isCompanyActualCost(record)) {
    return record.amountByn;
  }
  if (kind === 'LIABLE_ACTUAL' && isLiableActualCost(record)) {
    return record.amountByn;
  }
  if (kind === 'RECOVERY' && record.amountType === 'RECOVERY') {
    return record.amountByn;
  }
  if (kind === 'AVOIDED_LOSS' && record.amountType === 'AVOIDED_LOSS') {
    return record.amountByn;
  }
  return null;
}

export function sumMoney(amounts: ReadonlyArray<string | null>): string | null {
  const present = amounts.filter((amount): amount is string => amount != null && amount !== '');
  if (present.length === 0) {
    return null;
  }
  return present.reduce((total, amount) => addMoney(total, amount), '0.00');
}

export function addMoney(left: string, right: string): string {
  return formatScaled(
    parseScaled(left, MONEY_SCALE) + parseScaled(right, MONEY_SCALE),
    MONEY_SCALE,
  );
}

export function convertToByn(input: {
  amountOriginal: string;
  currency: string;
  exchangeRateToByn?: string | null;
}): { currency: string; exchangeRateToByn: string; amountByn: string } {
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError('currency', 'Валюта задаётся кодом из трёх букв');
  }
  const amount = parseScaled(input.amountOriginal, MONEY_SCALE);
  if (currency === 'BYN') {
    if (
      input.exchangeRateToByn != null &&
      input.exchangeRateToByn !== '' &&
      input.exchangeRateToByn !== '1'
    ) {
      throw new ValidationError('exchangeRateToByn', 'Для BYN курс равен 1');
    }
    return {
      currency,
      exchangeRateToByn: '1.000000',
      amountByn: formatScaled(amount, MONEY_SCALE),
    };
  }
  if (input.exchangeRateToByn == null || input.exchangeRateToByn === '') {
    throw new ValidationError('exchangeRateToByn', 'Для валюты, отличной от BYN, нужен курс');
  }
  const rate = parseScaled(input.exchangeRateToByn, RATE_SCALE);
  if (rate <= 0n) {
    throw new ValidationError('exchangeRateToByn', 'Курс должен быть больше нуля');
  }
  const product = amount * rate;
  const factor = 10n ** BigInt(RATE_SCALE);
  const half = factor / 2n;
  const sign = product < 0n ? -1n : 1n;
  const absolute = product < 0n ? -product : product;
  const rounded = (absolute + half) / factor;
  return {
    currency,
    exchangeRateToByn: formatScaled(rate, RATE_SCALE),
    amountByn: formatScaled(sign * rounded, MONEY_SCALE),
  };
}

function parseScaled(value: string, scale: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new ValidationError('amount', 'Сумма должна быть десятичным числом');
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > scale) {
    throw new ValidationError('amount', 'Слишком много знаков после запятой');
  }
  const digits = `${whole}${fraction.padEnd(scale, '0')}`;
  const parsed = BigInt(digits);
  return negative ? -parsed : parsed;
}

function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export interface RiskFactorInput {
  ageDays: number | null;
  overdue: boolean | null;
  rejectionCount: number | null;
  hasLiableOrganization: boolean | null;
  hasResponsible: boolean | null;
  severity: number | null;
  confirmedCostByn: string | null;
  defectTypeRepeatCount: number | null;
}

export interface RiskAssessment {
  score: number;
  used: string[];
  omitted: string[];
}

export function riskScore(input: RiskFactorInput): RiskAssessment {
  let score = 0;
  const used: string[] = [];
  const omitted: string[] = [];
  if (input.ageDays == null) {
    omitted.push('возраст');
  } else {
    score += Math.min(3, input.ageDays / 30);
    used.push('возраст');
  }
  if (input.overdue == null) {
    omitted.push('просрочка');
  } else if (input.overdue) {
    score += 2;
    used.push('просрочка');
  } else {
    used.push('просрочка');
  }
  if (input.rejectionCount == null) {
    omitted.push('предыдущие отклонения');
  } else {
    score += Math.min(3, input.rejectionCount);
    used.push('предыдущие отклонения');
  }
  if (input.hasLiableOrganization == null) {
    omitted.push('виновная организация');
  } else if (!input.hasLiableOrganization) {
    score += 1;
    used.push('виновная организация');
  } else {
    used.push('виновная организация');
  }
  if (input.hasResponsible == null) {
    omitted.push('ответственный');
  } else if (!input.hasResponsible) {
    score += 1;
    used.push('ответственный');
  } else {
    used.push('ответственный');
  }
  if (input.severity == null) {
    omitted.push('тяжесть');
  } else {
    score += Math.min(3, Math.max(0, input.severity));
    used.push('тяжесть');
  }
  if (input.confirmedCostByn == null) {
    omitted.push('подтверждённая стоимость');
  } else {
    const amount = Number(input.confirmedCostByn);
    if (Number.isFinite(amount) && amount > 0) {
      score += Math.min(3, Math.log10(amount + 1));
    }
    used.push('подтверждённая стоимость');
  }
  if (input.defectTypeRepeatCount == null) {
    omitted.push('повторяемость типа');
  } else if (input.defectTypeRepeatCount >= 3) {
    score += 1;
    used.push('повторяемость типа');
  } else {
    used.push('повторяемость типа');
  }
  return { score, used, omitted };
}

export interface QualityDebt {
  confirmedFinancialExposureByn: string | null;
  riskWeightedOpenBacklog: number;
  openDefects: number;
}

export function qualityDebt(input: {
  confirmedCompanyCostOnOpenDefects: ReadonlyArray<string | null>;
  openRiskScores: readonly number[];
}): QualityDebt {
  return {
    confirmedFinancialExposureByn: sumMoney(input.confirmedCompanyCostOnOpenDefects),
    riskWeightedOpenBacklog: input.openRiskScores.reduce((total, score) => total + score, 0),
    openDefects: input.openRiskScores.length,
  };
}

export interface IndexComponent {
  key: string;
  label: string;
  score: number | null;
  weight: number;
  included: boolean;
}

const INDEX_WEIGHTS = {
  firstTimeRight: 20,
  rework: 15,
  contractorSla: 15,
  overdue: 15,
  medianClosure: 10,
  repeat: 10,
  confirmedCost: 10,
  objectRepeat: 5,
} as const;

export function organizationQualityIndex(input: {
  sampleSize: number;
  firstTimeRight: number | null;
  reworkRate: number | null;
  contractorOnTimeRate: number | null;
  overdueShare: number | null;
  medianClosureDays: number | null;
  repeatShare: number | null;
  confirmedCostPerDefect: number | null;
  baselineCostPerDefect: number | null;
  objectRepeatShare: number | null;
}): { ranked: boolean; index: number | null; components: IndexComponent[] } {
  const components: IndexComponent[] = [
    component(
      'firstTimeRight',
      'First-Time-Right',
      input.firstTimeRight,
      INDEX_WEIGHTS.firstTimeRight,
      (value) => value * 100,
    ),
    component(
      'rework',
      'Rework Rate',
      input.reworkRate,
      INDEX_WEIGHTS.rework,
      (value) => (1 - value) * 100,
    ),
    component(
      'contractorSla',
      'Contractor SLA',
      input.contractorOnTimeRate,
      INDEX_WEIGHTS.contractorSla,
      (value) => value * 100,
    ),
    component(
      'overdue',
      'Просрочка',
      input.overdueShare,
      INDEX_WEIGHTS.overdue,
      (value) => (1 - value) * 100,
    ),
    component(
      'medianClosure',
      'Медиана закрытия',
      input.medianClosureDays,
      INDEX_WEIGHTS.medianClosure,
      (value) => (value <= 0 ? 100 : Math.max(0, Math.min(100, (14 / value) * 100))),
    ),
    component(
      'repeat',
      'Повторяемость',
      input.repeatShare,
      INDEX_WEIGHTS.repeat,
      (value) => (1 - value) * 100,
    ),
    component(
      'confirmedCost',
      'Подтверждённая стоимость',
      input.confirmedCostPerDefect != null &&
        input.baselineCostPerDefect != null &&
        input.baselineCostPerDefect > 0
        ? input.confirmedCostPerDefect / input.baselineCostPerDefect
        : null,
      INDEX_WEIGHTS.confirmedCost,
      (value) => Math.max(0, Math.min(100, (1 / value) * 100)),
    ),
    component(
      'objectRepeat',
      'Объекты с повторением',
      input.objectRepeatShare,
      INDEX_WEIGHTS.objectRepeat,
      (value) => (1 - value) * 100,
    ),
  ];
  const included = components.filter((item) => item.included && item.score != null);
  const weight = included.reduce((total, item) => total + item.weight, 0);
  const ranked = input.sampleSize >= ANALYTICS_MIN_ORG_SAMPLE && included.length > 0;
  if (!ranked || weight === 0) {
    return { ranked: false, index: null, components };
  }
  const index =
    included.reduce((total, item) => total + (item.score ?? 0) * item.weight, 0) / weight;
  return { ranked: true, index, components };
}

function component(
  key: string,
  label: string,
  raw: number | null,
  weight: number,
  project: (value: number) => number,
): IndexComponent {
  if (raw == null || !Number.isFinite(raw)) {
    return { key, label, score: null, weight, included: false };
  }
  return { key, label, score: project(raw), weight, included: true };
}

export interface ProportionSignalInput {
  signalType: AnalyticsSignalType;
  dimensions: Array<{ key: string; value: string; label: string }>;
  supportCount: number;
  positiveCount: number;
  totalCount: number;
  baselinePositive: number;
  baselineTotal: number;
  objectCount: number;
  sampleCoverage: number | null;
  periodFrom: string | null;
  periodTo: string | null;
  higherIsSignal: boolean;
}

export interface ProportionSignal {
  signalType: AnalyticsSignalType;
  title: string;
  plainLanguageExplanation: string;
  dimensions: Array<{ key: string; value: string; label: string }>;
  supportCount: number;
  totalCount: number;
  observedValue: number;
  baselineValue: number;
  lift: number | null;
  confidence: 'low' | 'medium' | 'high';
  sampleCoverage: number | null;
  periodFrom: string | null;
  periodTo: string | null;
  statisticallyStable: boolean;
  displayLabel: 'Сигнал для проверки' | 'Подтверждённая закономерность';
  signalKey: string;
}

export function assessProportionSignal(input: ProportionSignalInput): ProportionSignal | null {
  if (input.dimensions.length === 0 || input.dimensions.length > 3) {
    return null;
  }
  if (input.supportCount < ANALYTICS_WEAK_SUPPORT || input.totalCount <= 0) {
    return null;
  }
  const observed = ratio(input.positiveCount, input.supportCount);
  const baseline = ratio(input.baselinePositive, input.baselineTotal);
  if (observed == null || baseline == null) {
    return null;
  }
  const lift = baseline === 0 ? null : observed / baseline;
  const directionOk = input.higherIsSignal ? observed > baseline : observed < baseline;
  if (!directionOk) {
    return null;
  }
  const interval = wilsonInterval(
    input.higherIsSignal ? input.positiveCount : input.supportCount - input.positiveCount,
    input.supportCount,
    ANALYTICS_BONFERRONI_Z,
  );
  const stableComparison =
    interval != null &&
    (input.higherIsSignal ? interval.low > baseline : 1 - interval.high < baseline);
  const coverageOk = input.sampleCoverage == null || input.sampleCoverage >= ANALYTICS_MIN_COVERAGE;
  const objectsOk =
    !input.dimensions.some((dimension) => dimension.key === 'propertyObject') ||
    input.objectCount >= ANALYTICS_MIN_OBJECTS;
  const statisticallyStable =
    input.supportCount >= ANALYTICS_MIN_SUPPORT &&
    coverageOk &&
    objectsOk &&
    stableComparison &&
    lift != null;
  if (
    !statisticallyStable &&
    (lift == null || lift < 1.5 || input.supportCount < ANALYTICS_WEAK_SUPPORT)
  ) {
    return null;
  }
  const confidence = signalConfidence(input.supportCount, input.sampleCoverage, interval);
  const text = signalText(input, observed, baseline, lift, statisticallyStable);
  return {
    signalType: input.signalType,
    title: text.title,
    plainLanguageExplanation: text.explanation,
    dimensions: input.dimensions,
    supportCount: input.supportCount,
    totalCount: input.totalCount,
    observedValue: observed,
    baselineValue: baseline,
    lift,
    confidence,
    sampleCoverage: input.sampleCoverage,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    statisticallyStable,
    displayLabel: 'Сигнал для проверки',
    signalKey: analyticsSignalKey({
      signalType: input.signalType,
      dimensions: input.dimensions,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
    }),
  };
}

export function assessShareSignal(input: {
  signalType: AnalyticsSignalType;
  dimensions: Array<{ key: string; value: string; label: string }>;
  segmentCount: number;
  totalCount: number;
  peerCount: number;
  objectCount: number;
  sampleCoverage: number | null;
  periodFrom: string | null;
  periodTo: string | null;
}): ProportionSignal | null {
  if (input.peerCount < 2 || input.totalCount <= 0 || input.segmentCount < ANALYTICS_WEAK_SUPPORT) {
    return null;
  }
  const signal = assessProportionSignal({
    signalType: input.signalType,
    dimensions: input.dimensions,
    supportCount: input.totalCount,
    positiveCount: input.segmentCount,
    totalCount: input.totalCount,
    baselinePositive: 1,
    baselineTotal: input.peerCount,
    objectCount: input.objectCount,
    sampleCoverage: input.sampleCoverage,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    higherIsSignal: true,
  });
  if (!signal) {
    return null;
  }
  return { ...signal, supportCount: input.segmentCount };
}

export function signalDisplayLabel(
  status: 'NEW' | 'UNDER_REVIEW' | 'CONFIRMED' | 'DISMISSED',
): 'Сигнал для проверки' | 'Подтверждённая закономерность' {
  return status === 'CONFIRMED' ? 'Подтверждённая закономерность' : 'Сигнал для проверки';
}

function signalConfidence(
  support: number,
  coverage: number | null,
  interval: WilsonInterval | null,
): 'low' | 'medium' | 'high' {
  const width = interval == null ? 1 : interval.high - interval.low;
  if (
    support < ANALYTICS_MIN_SUPPORT ||
    (coverage != null && coverage < ANALYTICS_MIN_COVERAGE) ||
    width > 0.4
  ) {
    return 'low';
  }
  if (width > 0.2) {
    return 'medium';
  }
  return 'high';
}

function signalText(
  input: ProportionSignalInput,
  observed: number,
  baseline: number,
  lift: number | null,
  stable: boolean,
): { title: string; explanation: string } {
  const dims = input.dimensions.map((dimension) => `${dimension.label}`).join(', ');
  const multiplier =
    stable && lift != null && Number.isFinite(lift)
      ? `в ${lift.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} раза`
      : 'заметно';
  const cautious = stable ? '' : ' Выборка недостаточна для устойчивого вывода.';
  if (input.signalType === 'RESPONSIBILITY_CONCENTRATION') {
    return {
      title: 'Сигнал для проверки',
      explanation: `На ${dims} приходится ${percent(observed)} доля среди зарегистрированных дефектов. Базовый уровень сегмента в этой выборке: ${percent(baseline)}.${cautious}`,
    };
  }
  if (input.signalType === 'HIGH_REWORK' || input.signalType === 'LOW_FIRST_TIME_RIGHT') {
    return {
      title: 'Сигнал для проверки',
      explanation: `По сочетанию ${dims} повторное устранение наблюдается ${multiplier} относительно базового уровня ${percent(baseline)}. Это наблюдаемая связь в данных.${cautious}`,
    };
  }
  if (input.signalType === 'COST_CONCENTRATION') {
    return {
      title: 'Сигнал для проверки',
      explanation: `Подтверждённые затраты по ${dims} составляют ${percent(observed)} подтверждённой суммы выборки при базовой доле ${percent(baseline)}.${cautious}`,
    };
  }
  return {
    title: 'Сигнал для проверки',
    explanation: `По ${dims} показатель ${percent(observed)} выше базового уровня ${percent(baseline)}. Наблюдается связь. Отдельное исследование здесь не проводится.${cautious}`,
  };
}

function percent(value: number): string {
  return `${(value * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}

export function analyticsSignalKey(input: {
  signalType: string;
  dimensions: Array<{ key: string; value: string }>;
  periodFrom: string | null;
  periodTo: string | null;
}): string {
  const dimensions = [...input.dimensions].sort((a, b) =>
    `${a.key}:${a.value}`.localeCompare(`${b.key}:${b.value}`),
  );
  return createHash('sha256')
    .update(
      JSON.stringify({
        ruleVersion: ANALYTICS_RULE_VERSION,
        signalType: input.signalType,
        dimensions,
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

export function formatByn(amount: string | null): string {
  if (amount == null) {
    return 'Нет подтверждённых данных';
  }
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    return 'Нет подтверждённых данных';
  }
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} BYN`;
}

export function agingBucket(days: number): '0–3' | '4–7' | '8–14' | '15–30' | '31–60' | '60+' {
  if (days <= 3) return '0–3';
  if (days <= 7) return '4–7';
  if (days <= 14) return '8–14';
  if (days <= 30) return '15–30';
  if (days <= 60) return '31–60';
  return '60+';
}

export function seasonOfMonth(month: number): 'winter' | 'spring' | 'summer' | 'autumn' | null {
  if (month === 12 || month === 1 || month === 2) return 'winter';
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return null;
}

export const SHARE_WITHOUT_EXPOSURE_LABEL = 'Доля среди зарегистрированных дефектов';

export const MISSING_ANALYTICS_DIMENSIONS = [
  'секция',
  'этаж',
  'помещение как структурированное поле',
  'ориентация',
  'материал',
  'тяжесть',
  'объём выполненных работ',
] as const;
