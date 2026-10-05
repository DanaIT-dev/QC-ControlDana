import { describe, expect, it } from 'vitest';
import {
  addMoney,
  agingBucket,
  analyticsSignalKey,
  assessProportionSignal,
  attemptClock,
  convertToByn,
  durationStats,
  firstTimeRight,
  formatByn,
  formatCoverage,
  includedFinancialAmount,
  minskDayEnd,
  minskDayStart,
  organizationQualityIndex,
  percentile,
  qualityDebt,
  ratio,
  reworkRate,
  riskScore,
  seasonOfMonth,
  signalDisplayLabel,
  sumMoney,
  wilsonInterval,
} from './analytics';

describe('analytics time zone', () => {
  it('uses a fixed Europe/Minsk offset across former DST dates', () => {
    expect(minskDayStart('2026-03-29').toISOString()).toBe('2026-03-28T21:00:00.000Z');
    expect(minskDayStart('2026-10-25').toISOString()).toBe('2026-10-24T21:00:00.000Z');
    expect(minskDayEnd('2026-01-01').toISOString()).toBe('2026-01-01T20:59:59.999Z');
  });
});

describe('percentiles and empty data', () => {
  it('returns null for an empty set and does not divide by zero', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(ratio(1, 0)).toBeNull();
    expect(durationStats([])).toMatchObject({ median: null, sampleSize: 0, coverage: null });
    expect(
      firstTimeRight({
        completedAcceptedOnFirstAttempt: 0,
        completedWithAttempts: 0,
        completedDefects: 0,
      }).rate,
    ).toBeNull();
  });

  it('computes median, p75 and p90', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.5)).toBeCloseTo(5.5);
    expect(percentile(values, 0.75)).toBeCloseTo(7.75);
    expect(percentile(values, 0.9)).toBeCloseTo(9.1);
    const stats = durationStats([1, null, 3]);
    expect(stats.sampleSize).toBe(2);
    expect(stats.populationSize).toBe(3);
    expect(stats.coverage).toBeCloseTo(2 / 3);
  });
});

describe('first-time-right and rework', () => {
  it('uses only completed defects with recorded attempts', () => {
    const metric = firstTimeRight({
      completedAcceptedOnFirstAttempt: 8,
      completedWithAttempts: 10,
      completedDefects: 16,
    });
    expect(metric.rate).toBeCloseTo(0.8);
    expect(formatCoverage(metric.coverageNumerator, metric.coverageDenominator)).toBe(
      '10 из 16 дефектов имеют данные о попытках',
    );
    expect(reworkRate({ completedWithRejection: 2, completedWithAttempts: 10 }).rate).toBeCloseTo(
      0.2,
    );
  });

  it('does not invent attempts for imported legacy defects', () => {
    const metric = firstTimeRight({
      completedAcceptedOnFirstAttempt: 0,
      completedWithAttempts: 0,
      completedDefects: 4,
    });
    expect(metric.rate).toBeNull();
    expect(metric.coverage).toBe(0);
  });
});

describe('clocks and money', () => {
  it('stops contractor time while inspection is waiting', () => {
    const submitted = new Date('2026-01-02T09:00:00.000Z');
    const reviewed = new Date('2026-01-03T09:00:00.000Z');
    const clock = attemptClock({
      attemptNumber: 1,
      submittedAt: submitted,
      reviewedAt: reviewed,
      previousReviewedAt: null,
      workStartedAt: new Date('2026-01-01T09:00:00.000Z'),
    });
    expect(clock.contractorMs).toBe(86_400_000);
    expect(clock.inspectionMs).toBe(86_400_000);
    expect(clock.reworkMs).toBe(0);
    const rework = attemptClock(
      {
        attemptNumber: 2,
        submittedAt: new Date('2026-01-05T09:00:00.000Z'),
        reviewedAt: null,
        previousReviewedAt: reviewed,
        workStartedAt: new Date('2026-01-01T09:00:00.000Z'),
      },
      new Date('2026-01-05T21:00:00.000Z'),
    );
    expect(rework.reworkMs).toBe(2 * 86_400_000);
    expect(rework.contractorMs).toBe(2 * 86_400_000);
  });

  it('keeps proposals and amount types apart and converts currency with decimal rounding', () => {
    expect(
      includedFinancialAmount(
        { amountType: 'ESTIMATE', payerType: 'COMPANY', status: 'CONFIRMED', amountByn: '10.00' },
        'COMPANY_ACTUAL',
      ),
    ).toBeNull();
    expect(
      includedFinancialAmount(
        { amountType: 'ACTUAL_COST', payerType: 'COMPANY', status: 'VOIDED', amountByn: '10.00' },
        'COMPANY_ACTUAL',
      ),
    ).toBeNull();
    expect(
      includedFinancialAmount(
        {
          amountType: 'ACTUAL_COST',
          payerType: 'COMPANY',
          status: 'CONFIRMED',
          amountByn: '10.50',
        },
        'COMPANY_ACTUAL',
      ),
    ).toBe('10.50');
    expect(convertToByn({ amountOriginal: '10.00', currency: 'BYN' })).toMatchObject({
      exchangeRateToByn: '1.000000',
      amountByn: '10.00',
    });
    expect(
      convertToByn({ amountOriginal: '10.00', currency: 'USD', exchangeRateToByn: '3.255' })
        .amountByn,
    ).toBe('32.55');
    expect(sumMoney([null, null])).toBeNull();
    expect(sumMoney(['1.10', '-0.10'])).toBe('1.00');
    expect(addMoney('0.01', '0.02')).toBe('0.03');
    expect(formatByn(null)).toBe('Нет подтверждённых данных');
  });
});

describe('quality debt and organization index', () => {
  it('omits missing factors instead of inventing them', () => {
    const risk = riskScore({
      ageDays: 60,
      overdue: null,
      rejectionCount: null,
      hasLiableOrganization: false,
      hasResponsible: true,
      severity: null,
      confirmedCostByn: null,
      defectTypeRepeatCount: 3,
    });
    expect(risk.omitted).toContain('тяжесть');
    expect(risk.omitted).toContain('просрочка');
    expect(risk.used).not.toContain('тяжесть');
    const debt = qualityDebt({
      confirmedCompanyCostOnOpenDefects: [null],
      openRiskScores: [risk.score],
    });
    expect(debt.confirmedFinancialExposureByn).toBeNull();
    expect(debt.riskWeightedOpenBacklog).toBeGreaterThan(0);
  });

  it('does not rank a small organization sample', () => {
    const index = organizationQualityIndex({
      sampleSize: 2,
      firstTimeRight: 1,
      reworkRate: 0,
      contractorOnTimeRate: 1,
      overdueShare: 0,
      medianClosureDays: 3,
      repeatShare: 0,
      confirmedCostPerDefect: null,
      baselineCostPerDefect: null,
      objectRepeatShare: 0,
    });
    expect(index.ranked).toBe(false);
    expect(index.index).toBeNull();
    expect(index.components.find((item) => item.key === 'confirmedCost')?.included).toBe(false);
  });
});

describe('pattern engine limits', () => {
  it('hides a tiny sample and avoids causal wording', () => {
    expect(
      assessProportionSignal({
        signalType: 'HIGH_REWORK',
        dimensions: [{ key: 'defectType', value: 'windows', label: 'Оконные конструкции' }],
        supportCount: 2,
        positiveCount: 2,
        totalCount: 20,
        baselinePositive: 4,
        baselineTotal: 20,
        objectCount: 1,
        sampleCoverage: 1,
        periodFrom: '2026-01-01',
        periodTo: '2026-09-30',
        higherIsSignal: true,
      }),
    ).toBeNull();
  });

  it('keeps a review label until a person confirms the signal', () => {
    const signal = assessProportionSignal({
      signalType: 'HIGH_REWORK',
      dimensions: [
        { key: 'liableOrganization', value: 'org', label: 'Организация Х' },
        { key: 'defectType', value: 'windows', label: 'Оконные конструкции' },
      ],
      supportCount: 18,
      positiveCount: 11,
      totalCount: 40,
      baselinePositive: 10,
      baselineTotal: 40,
      objectCount: 3,
      sampleCoverage: 0.8,
      periodFrom: '2026-01-01',
      periodTo: '2026-09-30',
      higherIsSignal: true,
    });
    expect(signal?.displayLabel).toBe('Сигнал для проверки');
    expect(signal?.plainLanguageExplanation).not.toMatch(/является причиной/);
    expect(signal?.plainLanguageExplanation).toMatch(/наблюд|связ|базов/i);
    expect(signalDisplayLabel('CONFIRMED')).toBe('Подтверждённая закономерность');
    expect(wilsonInterval(11, 18)?.low).toBeGreaterThan(0);
    expect(wilsonInterval(1, 0)).toBeNull();
  });

  it('keeps the signal key stable', () => {
    const left = analyticsSignalKey({
      signalType: 'HIGH_REWORK',
      dimensions: [{ key: 'defectType', value: 'a' }],
      periodFrom: null,
      periodTo: null,
    });
    const right = analyticsSignalKey({
      signalType: 'HIGH_REWORK',
      dimensions: [{ key: 'defectType', value: 'a' }],
      periodFrom: null,
      periodTo: null,
    });
    expect(left).toBe(right);
  });
});

describe('calendar helpers', () => {
  it('buckets age and season without parsing free text', () => {
    expect(agingBucket(0)).toBe('0–3');
    expect(agingBucket(61)).toBe('60+');
    expect(seasonOfMonth(1)).toBe('winter');
    expect(seasonOfMonth(13)).toBeNull();
  });
});
