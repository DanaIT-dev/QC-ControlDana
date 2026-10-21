'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActStatus,
  AnalyticsCosts,
  AnalyticsOverview,
  AnalyticsPatternCard,
  DefectItemStatus,
} from '@sgr-registry/contracts';
import { ACT_STATUS_LABELS, DEFECT_ITEM_STATUS_LABELS } from '@sgr-registry/domain';
import { ChevronDownIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Cell,
  LabelList,
  XAxis,
  YAxis,
} from 'recharts';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, MetricSkeleton, TableSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  fetchAnalyticsCosts,
  fetchAnalyticsDataQuality,
  fetchAnalyticsDrilldown,
  fetchAnalyticsFilters,
  fetchAnalyticsLiability,
  fetchAnalyticsOverview,
  fetchAnalyticsPatterns,
  fetchAnalyticsProcess,
  fetchAnalyticsSupport,
  reviewInsight,
} from '@/lib/analytics-api';
import { queryKeys } from '@/lib/query-keys';

const UNAVAILABLE_METRIC_LABELS: Record<string, string> = {
  DetectionToAssignment: 'Время от обнаружения дефекта до назначения ответственного',
  AssignmentToWorkStart: 'Время от назначения ответственного до начала работ',
};

const AMOUNT_TYPE_LABELS: Record<string, string> = {
  ESTIMATE: 'Оценка',
  APPROVED_AMOUNT: 'Согласованная сумма',
  ACTUAL_COST: 'Фактические затраты',
  RECOVERY: 'Возмещение',
  AVOIDED_LOSS: 'Предотвращённые потери',
};

const PAYER_TYPE_LABELS: Record<string, string> = {
  COMPANY: 'Компания',
  LIABLE_ORGANIZATION: 'Виновная организация',
  CUSTOMER: 'Заказчик',
  OTHER: 'Другой',
};

const CONFIDENCE_LABELS: Record<string, string> = {
  low: 'низкая',
  medium: 'средняя',
  high: 'высокая',
};

const INSIGHT_STATUS_LABELS: Record<string, string> = {
  NEW: 'Новый',
  UNDER_REVIEW: 'На проверке',
  CONFIRMED: 'Подтверждён',
  DISMISSED: 'Отклонён',
};

function named(labels: Record<string, string>, value: string): string {
  return labels[value] ?? value;
}

function recordStatus(status: string): string {
  return (
    DEFECT_ITEM_STATUS_LABELS[status as DefectItemStatus] ??
    ACT_STATUS_LABELS[status as ActStatus] ??
    status
  );
}

function readableAnalyticsText(value: string): string {
  return value
    .replaceAll(
      'First-Time-Right ниже базового уровня',
      'Принятие с первой попытки ниже базового уровня',
    )
    .replaceAll('First-Time-Right', 'принятия с первой попытки')
    .replaceAll('Support snapshot unavailable', 'Снимок исходных дефектов недоступен');
}

const TABS = [
  ['overview', 'Обзор'],
  ['costs', 'Финансы'],
  ['liability', 'Ответственность'],
  ['process', 'Скорость'],
  ['patterns', 'Паттерны'],
  ['data-quality', 'Качество данных'],
  ['drilldown', 'Исходные записи'],
] as const;

export function AnalyticsView({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const search = params.toString();
  const filterParams = new URLSearchParams(search);
  filterParams.delete('insightId');
  filterParams.delete('sort');
  filterParams.delete('direction');
  const filterSearch = filterParams.toString();
  const suffix = filterSearch ? `?${filterSearch}` : '';
  const tab = params.get('tab') ?? 'overview';
  const overview = useQuery({
    queryKey: queryKeys.analytics.overview(filterSearch),
    queryFn: () => fetchAnalyticsOverview(suffix),
  });
  const filters = useQuery({
    queryKey: queryKeys.analytics.filters(filterSearch),
    queryFn: () => fetchAnalyticsFilters(suffix),
  });

  const paramsRef = useRef(search);
  const staleSearch = useRef<string | null>(null);
  if (search !== paramsRef.current && search !== staleSearch.current) {
    paramsRef.current = search;
  }

  function update(next: Record<string, string | null>) {
    const current = new URLSearchParams(paramsRef.current);
    for (const [key, value] of Object.entries(next)) {
      if (!value) current.delete(key);
      else current.set(key, value);
    }
    if (!('page' in next)) current.delete('page');
    const encoded = current.toString();
    staleSearch.current = search;
    paramsRef.current = encoded;
    router.replace(`/analytics${encoded ? `?${encoded}` : ''}`);
  }

  function openMetric(metric: string) {
    if (metric.startsWith('insight:')) {
      update({
        tab: 'drilldown',
        metric: null,
        insightId: metric.slice('insight:'.length),
      });
      return;
    }
    update({ tab: 'drilldown', metric, insightId: null });
  }

  return (
    <div className="min-w-0">
      <PageHeader
        title="Аналитика"
        description="Качество, ответственность и подтверждённые потери. Показатели считаются на сервере по минскому времени и не смешивают предложения с расходами."
      />
      <FilterBar
        dateFrom={params.get('dateFrom') ?? ''}
        dateTo={params.get('dateTo') ?? ''}
        objectId={params.get('propertyObjectId') ?? ''}
        objects={filters.data?.objects ?? []}
        onChange={update}
      />
      <Tabs value={tab} onValueChange={(value) => update({ tab: value })}>
        <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start">
          {TABS.filter(([id]) => id !== 'costs' || overview.data?.financialVisible !== false).map(
            ([id, label]) => (
              <TabsTrigger key={id} value={id}>
                {label}
              </TabsTrigger>
            ),
          )}
        </TabsList>
        <TabsContent value="overview">
          {overview.isLoading ? <MetricSkeleton /> : null}
          {overview.isError ? (
            <ErrorState
              description="Обзор не загрузился."
              onRetry={() => void overview.refetch()}
            />
          ) : null}
          {overview.data ? <OverviewPane data={overview.data} onOpen={openMetric} /> : null}
        </TabsContent>
        <TabsContent value="costs">
          <CostsPane search={filterSearch} suffix={suffix} onOpen={openMetric} />
        </TabsContent>
        <TabsContent value="liability">
          <LiabilityPane search={filterSearch} suffix={suffix} />
        </TabsContent>
        <TabsContent value="process">
          <ProcessPane search={filterSearch} suffix={suffix} onOpen={openMetric} />
        </TabsContent>
        <TabsContent value="patterns">
          <PatternsPane
            search={filterSearch}
            suffix={suffix}
            csrfToken={csrfToken}
            onOpen={openMetric}
          />
        </TabsContent>
        <TabsContent value="data-quality">
          <QualityPane search={filterSearch} suffix={suffix} onOpen={openMetric} />
        </TabsContent>
        <TabsContent value="drilldown">
          {params.get('insightId') ? (
            <SupportPane
              insightId={params.get('insightId') ?? ''}
              search={search}
              onBack={() => update({ tab: 'patterns', insightId: null })}
              onPage={(page) =>
                update({ page, tab: 'drilldown', insightId: params.get('insightId') })
              }
            />
          ) : (
            <DrilldownPane
              search={filterSearch}
              suffix={suffix}
              page={params.get('page') ?? '1'}
              onPage={(page) => update({ page, tab: 'drilldown' })}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FilterBar({
  dateFrom,
  dateTo,
  objectId,
  objects,
  onChange,
}: {
  dateFrom: string;
  dateTo: string;
  objectId: string;
  objects: Array<{ id: string; label: string }>;
  onChange: (next: Record<string, string | null>) => void;
}) {
  const [from, setFrom] = useState(dateFrom);
  const [to, setTo] = useState(dateTo);
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== fromRef.current) setFrom(dateFrom);
  }, [dateFrom]);
  useEffect(() => {
    if (document.activeElement !== toRef.current) setTo(dateTo);
  }, [dateTo]);
  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-xs text-muted-foreground">
        Дата регистрации с
        <Input
          ref={fromRef}
          type="date"
          value={from}
          suppressHydrationWarning
          onChange={(event) => {
            setFrom(event.target.value);
            onChange({ dateFrom: event.target.value || null });
          }}
        />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        Дата регистрации по
        <Input
          ref={toRef}
          type="date"
          value={to}
          suppressHydrationWarning
          onChange={(event) => {
            setTo(event.target.value);
            onChange({ dateTo: event.target.value || null });
          }}
        />
      </label>
      <label className="grid min-w-40 gap-1 text-xs text-muted-foreground">
        Объект
        <div className="relative">
          <select
            className="h-11 w-full appearance-none rounded-lg border border-input bg-white py-2 pr-10 pl-3 text-sm text-foreground dark:bg-input/30"
            value={objectId}
            aria-label="Объект"
            onChange={(event) => onChange({ propertyObjectId: event.target.value || null })}
          >
            <option value="">Все доступные</option>
            {objects.map((object) => (
              <option key={object.id} value={object.id} title={object.label}>
                {object.label}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-muted-foreground" />
        </div>
      </label>
    </div>
  );
}

function OverviewPane({
  data,
  onOpen,
}: {
  data: AnalyticsOverview;
  onOpen: (metric: string) => void;
}) {
  const cards = [
    ...(data.financialVisible
      ? ([
          [
            'Подтверждённые затраты Dana',
            formatMoney(data.companyActualCostByn ?? null),
            'companyActualCost',
          ],
        ] as const)
      : []),
    ['Открытые дефекты', String(data.openDefects), 'openDefects'],
    ['Просрочено', String(data.overdueDefects), 'overdueDefects'],
    ['Медиана закрытия', formatDuration(data.medianClosureMs), 'closedInPeriod'],
    ['90% закрытий не дольше', formatDuration(data.p90ClosureMs), 'closedInPeriod'],
    ['Принятие с первой попытки', formatRate(data.firstTimeRight.rate), 'firstTimeRight'],
    [
      'Среднее число попыток',
      data.averageAttempts == null
        ? 'Нет данных'
        : data.averageAttempts.toLocaleString('ru-RU', { maximumFractionDigits: 2 }),
      'withAttempts',
    ],
    ['Новые сигналы', String(data.newInsights), 'defects'],
  ] as const;
  return (
    <div className="grid gap-4" data-analytics-ready="true">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map(([label, value, metric]) => (
          <button
            key={label}
            type="button"
            className="min-h-11 rounded-[10px] border bg-card p-3 text-left"
            onClick={() => onOpen(metric)}
          >
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-xl font-semibold">{value}</p>
          </button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">{data.firstTimeRight.coverageText}</p>
      {data.confirmedFinancialExposure ? (
        <ExposureCard exposure={data.confirmedFinancialExposure} onOpen={onOpen} />
      ) : null}
      {data.riskWeightedOpenBacklog ? (
        <BacklogCard backlog={data.riskWeightedOpenBacklog} onOpen={onOpen} />
      ) : null}
      <BarChart
        title="Открыто и закрыто"
        compact
        valueLabel="Открыто"
        secondaryLabel="Закрыто"
        valueColor="var(--error-foreground)"
        secondaryColor="var(--success-foreground)"
        rows={data.openedClosed.map((row) => ({
          label: row.period,
          value: row.opened,
          secondary: row.closed,
        }))}
      />
      <BarChart
        title="Возраст открытых дефектов"
        description="Интервалы в днях с даты составления акта."
        valueLabel="Дефекты"
        rows={data.backlogAge.map((row) => ({ label: ageDaysLabel(row.bucket), value: row.count }))}
      />
      <SimpleTable
        title="Топ рисков"
        description="Индекс риска открытого дефекта, не сумма в деньгах. Чем выше число, тем выше приоритет. Максимум 14 баллов: возраст до 3 (1 балл за каждые 30 дней), просроченный срок +2, каждое отклонение проверки +1 и не больше 3, нет виновной организации +1, нет ответственного инженера +1, подтверждённые затраты компании до 3, один и тот же вид дефекта встречается 3 раза и чаще +1. В колонке «Дефект» — помещение, а если его нет, вид дефекта."
        columns={['Дефект', 'Индекс риска']}
        rows={data.topRisks.map((row) => [row.label, formatRiskScore(row.score)])}
        empty="Нет открытых дефектов в доступной выборке."
      />
      {data.financialVisible ? (
        <SimpleTable
          title="Организации по подтверждённому влиянию"
          columns={['Организация', 'BYN']}
          rows={(data.topOrganizations ?? []).map((row) => [row.name, formatMoney(row.amountByn)])}
          empty="Нет подтверждённых затрат компании."
        />
      ) : null}
    </div>
  );
}

function ExposureCard({
  exposure,
  onOpen,
}: {
  exposure: NonNullable<AnalyticsOverview['confirmedFinancialExposure']>;
  onOpen: (metric: string) => void;
}) {
  const period =
    [exposure.periodFrom, exposure.periodTo].filter(Boolean).join(' – ') || 'весь доступный период';
  return (
    <button
      type="button"
      className="min-h-28 rounded-[10px] border bg-card p-3 text-left"
      title="Чистая нагрузка — подтверждённые фактические затраты компании минус подтверждённые возмещения. Оценка, согласованная сумма, предотвращённые потери, черновик и аннулированная запись не входят."
      onClick={() => onOpen('confirmedExposure')}
    >
      <p className="text-xs text-muted-foreground">Подтверждённая финансовая нагрузка</p>
      <p className="text-xl font-semibold">
        {exposure.available && exposure.netConfirmedExposureByn
          ? formatMoney(exposure.netConfirmedExposureByn)
          : 'Нет подтверждённых данных'}
      </p>
      {exposure.available ? (
        <p className="text-xs text-muted-foreground">
          Расходы {formatMoney(exposure.grossCompanyCostByn ?? null)}, возмещения{' '}
          {formatMoney(exposure.confirmedRecoveryByn ?? null)}, записей {exposure.recordCount},{' '}
          {exposure.currency}, {period}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Период: {period}</p>
      )}
    </button>
  );
}

function BacklogCard({
  backlog,
  onOpen,
}: {
  backlog: NonNullable<AnalyticsOverview['riskWeightedOpenBacklog']>;
  onOpen: (metric: string) => void;
}) {
  return (
    <button
      type="button"
      className="min-h-28 rounded-[10px] border bg-card p-3 text-left"
      title={`Сумма базовой оценки открытого дефекта, умноженной на коэффициент риска. База: последняя подтверждённая согласованная сумма, иначе оценка. Коэффициент: 1,00; просрочка +0,25; каждое отклонение после первого +0,15; ожидание проверки дольше ${backlog.inspectionWaitDays} дней +0,20; максимум 2,00. Формула ${backlog.formulaVersion}.`}
      onClick={() => onOpen('riskWeightedBacklog')}
    >
      <p className="text-xs text-muted-foreground">Риск-взвешенный открытый долг</p>
      <p className="text-xl font-semibold">
        {backlog.available && backlog.weightedByn
          ? formatMoney(backlog.weightedByn)
          : 'Недостаточно подтверждённых финансовых данных'}
      </p>
      <p className="text-xs text-muted-foreground">
        Оценено {backlog.evaluatedDefects} из {backlog.openDefects}. Покрытие{' '}
        {backlog.monetaryCoverage == null ? 'нет базы' : formatRate(backlog.monetaryCoverage)}.
        Формула {backlog.formulaVersion}. Расчёт {backlog.calculatedAt.slice(0, 10)}.
      </p>
    </button>
  );
}

function CostsPane({
  search,
  suffix,
  onOpen,
}: {
  search: string;
  suffix: string;
  onOpen: (metric: string) => void;
}) {
  const query = useQuery({
    queryKey: queryKeys.analytics.costs(search),
    queryFn: () => fetchAnalyticsCosts(suffix),
  });
  if (query.isLoading) return <TableSkeleton />;
  if (query.isError)
    return (
      <ErrorState
        description="Финансы недоступны или не загрузились."
        onRetry={() => void query.refetch()}
      />
    );
  if (!query.data) return null;
  const data: AnalyticsCosts = query.data;
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <MetricButton
          label="Затраты Dana"
          value={formatMoney(data.companyActualCostByn)}
          onClick={() => onOpen('companyActualCost')}
        />
        <MetricButton
          label="Затраты виновных организаций"
          value={formatMoney(data.liableActualCostByn)}
          onClick={() => onOpen('liableActualCost')}
        />
        <MetricButton
          label="Возмещения"
          value={formatMoney(data.recoveryByn)}
          onClick={() => onOpen('recovery')}
        />
        <MetricButton
          label="Предотвращённые потери"
          value={formatMoney(data.avoidedLossByn)}
          onClick={() => onOpen('avoidedLoss')}
        />
        <MetricButton
          label="Стоимость повторных устранений"
          value={formatMoney(data.reworkCostByn)}
          onClick={() => onOpen('reworkCost')}
        />
        <MetricButton
          label="Медиана стоимости дефекта"
          value={formatMoney(data.medianDefectCostByn)}
          onClick={() => onOpen('companyActualCost')}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Выборка подтверждённых затрат компании: {data.costSampleSize}. Предложения подрядчиков сюда
        не входят.
      </p>
      <BarChart
        title="Затраты по периодам"
        rows={data.byPeriod.map((row) => ({ label: row.period, value: Number(row.amountByn) }))}
      />
      <SimpleTable
        title="Подтверждённые записи"
        columns={['Тип', 'Плательщик', 'Сумма', 'Дата']}
        rows={data.records.map((row) => [
          named(AMOUNT_TYPE_LABELS, row.amountType),
          named(PAYER_TYPE_LABELS, row.payerType),
          formatMoney(row.amountByn),
          row.occurredAt.slice(0, 10),
        ])}
        empty="Нет подтверждённых финансовых записей."
      />
    </div>
  );
}

function LiabilityPane({ search, suffix }: { search: string; suffix: string }) {
  const query = useQuery({
    queryKey: queryKeys.analytics.liability(search),
    queryFn: () => fetchAnalyticsLiability(suffix),
  });
  if (query.isLoading) return <TableSkeleton />;
  if (query.isError)
    return (
      <ErrorState
        description="Ответственность не загрузилась."
        onRetry={() => void query.refetch()}
      />
    );
  if (!query.data || query.data.rows.length === 0) {
    return (
      <EmptyState
        title="Недостаточно данных"
        description="В доступной выборке нет виновных организаций."
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <caption className="sr-only">
          Индекс качества организаций. Доля считается среди зарегистрированных дефектов.
        </caption>
        <thead>
          <tr className="border-b text-left">
            {[
              'Организация',
              'Дефекты',
              'Доля среди зарегистрированных дефектов',
              'Принятие с первой попытки',
              'Доля повторных устранений',
              'Просрочка',
              'Выборка',
              'Индекс',
            ].map((column) => (
              <th key={column} className="px-2 py-2 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {query.data.rows.map((row) => (
            <tr key={row.organizationId} className="border-b">
              <td className="max-w-48 truncate px-2 py-2" title={row.name}>
                {row.name}
              </td>
              <td className="px-2 py-2">{row.defects}</td>
              <td className="px-2 py-2">{formatRate(row.share)}</td>
              <td className="px-2 py-2">{formatRate(row.firstTimeRight)}</td>
              <td className="px-2 py-2">{formatRate(row.reworkRate)}</td>
              <td className="px-2 py-2">{formatRate(row.overdueShare)}</td>
              <td className="px-2 py-2">{row.sampleSize}</td>
              <td className="px-2 py-2">
                {row.ranked && row.index != null
                  ? row.index.toLocaleString('ru-RU', { maximumFractionDigits: 1 })
                  : 'Мало данных'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProcessPane({
  search,
  suffix,
  onOpen,
}: {
  search: string;
  suffix: string;
  onOpen: (metric: string) => void;
}) {
  const query = useQuery({
    queryKey: queryKeys.analytics.process(search),
    queryFn: () => fetchAnalyticsProcess(suffix),
  });
  if (query.isLoading) return <TableSkeleton />;
  if (query.isError)
    return (
      <ErrorState description="Скорость не загрузилась." onRetry={() => void query.refetch()} />
    );
  if (!query.data) return null;
  const data = query.data;
  return (
    <div className="grid gap-4">
      <BarChart
        title="Воронка статусов"
        valueLabel="Дефекты"
        rows={data.funnel.map((row, index) => ({
          label: row.label,
          value: row.count,
          color: FUNNEL_COLORS[index] ?? 'var(--primary)',
        }))}
      />
      <SimpleTable
        title="Длительности"
        columns={['Показатель', 'Медиана', '75% не дольше', '90% не дольше', 'Выборка']}
        rows={[
          [
            'Время подрядчика',
            formatDuration(data.contractor.median),
            formatDuration(data.contractor.p75),
            formatDuration(data.contractor.p90),
            String(data.contractor.sampleSize),
          ],
          [
            data.inspectionLabel,
            formatDuration(data.inspection.median),
            formatDuration(data.inspection.p75),
            formatDuration(data.inspection.p90),
            String(data.inspection.sampleSize),
          ],
          [
            'Повторное устранение',
            formatDuration(data.rework.median),
            formatDuration(data.rework.p75),
            formatDuration(data.rework.p90),
            String(data.rework.sampleSize),
          ],
          [
            'Календарное закрытие',
            formatDuration(data.total.median),
            formatDuration(data.total.p75),
            formatDuration(data.total.p90),
            String(data.total.sampleSize),
          ],
        ]}
        empty="Нет временных меток попыток."
      />
      <p className="text-sm text-muted-foreground">
        Время ожидания проверки не включается во время подрядчика. Время от обнаружения дефекта до
        назначения ответственного и время от назначения до начала работ пока не считаются: система
        не фиксирует эти события.
      </p>
      <button
        type="button"
        className="min-h-11 text-left text-sm underline"
        onClick={() => onOpen('noMovement')}
      >
        Без движения: {data.noMovement}
      </button>
      <BarChart
        title="Возраст открытых дефектов"
        description="Интервалы в днях с даты составления акта."
        valueLabel="Дефекты"
        rows={data.aging.map((row) => ({ label: ageDaysLabel(row.bucket), value: row.count }))}
      />
    </div>
  );
}

function PatternsPane({
  search,
  suffix,
  csrfToken,
  onOpen,
}: {
  search: string;
  suffix: string;
  csrfToken: string;
  onOpen: (metric: string) => void;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.analytics.patterns(search),
    queryFn: () => fetchAnalyticsPatterns(suffix),
  });
  if (query.isLoading) return <TableSkeleton />;
  if (query.isError)
    return (
      <ErrorState description="Сигналы не загрузились." onRetry={() => void query.refetch()} />
    );
  if (!query.data || query.data.items.length === 0) {
    return (
      <EmptyState
        title="Сигналов нет"
        description="В доступной выборке нет сочетаний, которые проходят минимальный объём и отличие от базового уровня."
      />
    );
  }
  return (
    <div className="grid gap-3">
      {query.data.items.map((item) => (
        <PatternCard
          key={item.id}
          item={item}
          csrfToken={csrfToken}
          onOpen={onOpen}
          onChanged={() =>
            void client.invalidateQueries({ queryKey: queryKeys.analytics.patterns(search) })
          }
        />
      ))}
    </div>
  );
}

function PatternCard({
  item,
  csrfToken,
  onOpen,
  onChanged,
}: {
  item: AnalyticsPatternCard;
  csrfToken: string;
  onOpen: (metric: string) => void;
  onChanged: () => void;
}) {
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function review(status: 'CONFIRMED' | 'DISMISSED') {
    setError(null);
    try {
      await reviewInsight(item.id, csrfToken, { status, comment });
      onChanged();
    } catch {
      setError('Не удалось сохранить решение.');
    }
  }
  return (
    <Card data-signal-type={item.signalType}>
      <CardHeader>
        <CardTitle className="text-base">{item.displayLabel}</CardTitle>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-2 text-sm break-words">
        <p className="break-words">{item.plainLanguageExplanation}</p>
        <p>
          Выборка: {item.supportCount}. Базовый уровень: {formatRate(item.baselineValue)}.
          Достоверность: {named(CONFIDENCE_LABELS, item.confidence)}. Статус:{' '}
          {named(INSIGHT_STATUS_LABELS, item.status)}.
        </p>
        <p className="text-xs text-muted-foreground">
          Правило {item.ruleVersion}. Рассчитано {item.generatedAt.slice(0, 10)}. Покрытие{' '}
          {formatRate(item.sampleCoverage)}.
        </p>
        {item.supportAvailable ? (
          <button
            type="button"
            className="min-h-11 w-fit underline"
            onClick={() => onOpen(`insight:${item.id}`)}
          >
            Показать исходные дефекты
          </button>
        ) : (
          <p>Снимок исходных дефектов недоступен</p>
        )}
        {item.canReview ? (
          <div className="grid gap-2">
            <Input
              aria-label="Комментарий к сигналу"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Комментарий проверки"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void review('CONFIRMED')}>
                Подтвердить
              </Button>
              <Button type="button" variant="outline" onClick={() => void review('DISMISSED')}>
                Отклонить
              </Button>
            </div>
            {error ? <p className="text-destructive">{error}</p> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function QualityPane({
  search,
  suffix,
  onOpen,
}: {
  search: string;
  suffix: string;
  onOpen: (metric: string) => void;
}) {
  const query = useQuery({
    queryKey: queryKeys.analytics.quality(search),
    queryFn: () => fetchAnalyticsDataQuality(suffix),
  });
  if (query.isLoading) return <TableSkeleton />;
  if (query.isError)
    return (
      <ErrorState
        description="Качество данных не загрузилось."
        onRetry={() => void query.refetch()}
      />
    );
  if (!query.data) return null;
  const data = query.data;
  const rows: Array<[string, number, string]> = [
    ['Без вида работ', data.missingWorkType, 'defects'],
    ['Без виновной организации', data.missingLiableOrganization, 'noLiableOrganization'],
    ['Без ответственного', data.missingResponsible, 'noResponsible'],
    ['Срок не установлен', data.missingDeadline, 'defects'],
    ['Без истории попыток', data.missingAttemptHistory, 'withoutAttempts'],
    ...(data.coverage.some((item) => item.metric === 'financial')
      ? ([['Без финансовых данных', data.missingFinancialData, 'defects']] as Array<
          [string, number, string]
        >)
      : []),
    ['Несопоставленные инженеры', data.unresolvedEngineers, 'defects'],
    ['Импортированные записи', data.importedRecords, 'defects'],
    ['Неполное время событий', data.incompleteTimestamps, 'defects'],
    ['Некорректная последовательность событий', data.invalidTemporalRecords, 'invalidTemporal'],
  ];
  return (
    <div className="grid gap-4">
      <SimpleTable
        title="Пробелы"
        columns={['Признак', 'Количество']}
        rows={rows.map(([label, count]) => [label, String(count)])}
        empty="Нет дефектов в выборке."
      />
      <div className="flex flex-wrap gap-2">
        {rows.map(([label, , metric]) => (
          <Button key={label} type="button" variant="outline" onClick={() => onOpen(metric)}>
            {label}
          </Button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        Недоступные измерения: {data.unavailableDimensions.join(', ')}. Тип дефекта обязателен в
        модели, поэтому пропуск типа равен 0. Записей объёма работ: {data.workExposureRecords}.
        Пустая экспозиция не отключает остальные вкладки. Эти измерения нужно начать сохранять
        отдельно, без разбора свободного текста.
      </p>
      <SimpleTable
        title="Недоступные метрики"
        columns={['Метрика', 'Причина']}
        rows={data.unavailableMetrics.map((item) => [
          named(UNAVAILABLE_METRIC_LABELS, item.metric),
          item.reason,
        ])}
        empty="Все рассчитанные метрики доступны."
      />
      <SimpleTable
        title="Покрытие"
        columns={['Метрика', 'Покрыто', 'Всего']}
        rows={data.coverage.map((row) => [row.label, String(row.covered), String(row.total)])}
        empty="Нет дефектов."
      />
    </div>
  );
}

function SupportPane({
  insightId,
  search,
  onBack,
  onPage,
}: {
  insightId: string;
  search: string;
  onBack: () => void;
  onPage: (page: string) => void;
}) {
  const page = new URLSearchParams(search).get('page') ?? '1';
  const query = useQuery({
    queryKey: queryKeys.analytics.support(insightId, search),
    queryFn: () => fetchAnalyticsSupport(insightId, search),
  });
  if (query.isLoading) return <TableSkeleton />;
  if (query.isError) {
    return (
      <ErrorState
        description="Исходные дефекты сигнала не загрузились."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return null;
  const data = query.data;
  return (
    <div className="grid min-w-0 gap-3">
      <button type="button" className="min-h-11 w-fit underline" onClick={onBack}>
        Назад к паттернам
      </button>
      <h2 className="text-lg font-semibold">
        {data.title ? readableAnalyticsText(data.title) : 'Сигнал'}
      </h2>
      <p className="text-sm text-muted-foreground">
        Выборка: {data.supportCount}. Правило {data.ruleVersion ?? '—'}. Расчёт{' '}
        {data.observedAt?.slice(0, 10) ?? '—'}. {data.unavailableReason ?? ''}
      </p>
      <div className="max-w-full overflow-x-auto">
        <SimpleTable
          title="Дефекты сигнала"
          columns={[
            'Акт',
            'Дефект',
            'Объект',
            'Тип',
            'Работы',
            'Организация',
            'Статус',
            'Срок',
            'Попытки',
            'Причина',
          ]}
          rows={data.items.map((item) => [
            item.actNumber ?? item.actId,
            item.label,
            item.objectName,
            item.defectType,
            item.workType ?? '—',
            item.liableOrganizations.join(', ') || '—',
            recordStatus(item.status),
            item.deadline ? item.deadline.slice(0, 10) : '—',
            String(item.attemptCount),
            item.contributionReason ? readableAnalyticsText(item.contributionReason) : '—',
          ])}
          empty={data.unavailableReason ?? 'В доступной области нет дефектов этого сигнала.'}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {data.items.map((item) => (
          <Link key={item.defectItemId} className="underline" href={`/acts/${item.actId}`}>
            Акт {item.actNumber ?? item.actId}
          </Link>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => onPage(String(Math.max(1, Number(page) - 1)))}
        >
          Назад
        </Button>
        <Button type="button" variant="outline" onClick={() => onPage(String(Number(page) + 1))}>
          Дальше
        </Button>
      </div>
    </div>
  );
}

function DrilldownPane({
  search,
  suffix,
  page,
  onPage,
}: {
  search: string;
  suffix: string;
  page: string;
  onPage: (page: string) => void;
}) {
  const metric = new URLSearchParams(search).get('metric');
  const query = useQuery({
    queryKey: queryKeys.analytics.drilldown(search),
    queryFn: () => fetchAnalyticsDrilldown(suffix),
    enabled: Boolean(metric),
  });
  if (!metric) {
    return (
      <EmptyState
        title="Выберите показатель"
        description="Список исходных записей открывается из карточки показателя, строки или сигнала."
      />
    );
  }
  if (query.isLoading) return <TableSkeleton />;
  if (query.isError)
    return (
      <ErrorState
        description="Исходные записи не загрузились."
        onRetry={() => void query.refetch()}
      />
    );
  if (!query.data || query.data.items.length === 0) {
    return (
      <EmptyState
        title="Записей нет"
        description="Для этого показателя и фильтров сервер не нашёл дефектов. Нулевая сумма не подставляется вместо отсутствия данных."
      />
    );
  }
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        Записей: {query.data.total}. Страница {query.data.page}.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b text-left">
              {['Акт', 'Запись', 'Объект', 'Организации', 'Статус'].map((column) => (
                <th key={column} className="px-2 py-2 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {query.data.items.map((item) => (
              <tr key={`${item.actId}-${item.defectItemId ?? 'act'}`} className="border-b">
                <td className="px-2 py-2">
                  <Link className="underline" href={`/acts/${item.actId}`}>
                    {item.actNumber ?? 'Акт'}
                  </Link>
                </td>
                <td className="max-w-48 truncate px-2 py-2">{item.label || '—'}</td>
                <td className="max-w-48 truncate px-2 py-2" title={item.objectName}>
                  {item.objectName}
                </td>
                <td
                  className="max-w-48 truncate px-2 py-2"
                  title={item.liableOrganizations.join(', ')}
                >
                  {item.liableOrganizations.join(', ') || '—'}
                </td>
                <td className="px-2 py-2">{recordStatus(item.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={query.data.page <= 1}
          onClick={() => onPage(String(query.data.page - 1))}
        >
          Назад
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={query.data.page * query.data.pageSize >= query.data.total}
          onClick={() => onPage(String(Number(page) + 1))}
        >
          Дальше
        </Button>
      </div>
    </div>
  );
}

const FUNNEL_COLORS = [
  'var(--primary)',
  'var(--warning-foreground)',
  'var(--success-foreground)',
] as const;

function formatChartNumber(value: number): string {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

function ageDaysLabel(bucket: string): string {
  return `${bucket} дн.`;
}

function formatRiskScore(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return value;
  }
  return numeric.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

function BarValueLabel(props: {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  value?: number | string | null | boolean | readonly (number | string)[];
}) {
  const x = Number(props.x ?? 0);
  const y = Number(props.y ?? 0);
  const width = Number(props.width ?? 0);
  const height = Number(props.height ?? 0);
  const numeric = Number(props.value ?? 0);
  return (
    <text
      x={x + width + 8}
      y={y + height / 2}
      fill="var(--foreground)"
      fontSize={12}
      dominantBaseline="central"
    >
      {formatChartNumber(Number.isFinite(numeric) ? numeric : 0)}
    </text>
  );
}

function BarChart({
  title,
  rows,
  description,
  compact = false,
  valueLabel = 'Значение',
  secondaryLabel = 'Вторая серия',
  valueColor = 'var(--primary)',
  secondaryColor = 'var(--brand)',
}: {
  title: string;
  rows: Array<{ label: string; value: number; secondary?: number; color?: string }>;
  description?: string;
  compact?: boolean;
  valueLabel?: string;
  secondaryLabel?: string;
  valueColor?: string;
  secondaryColor?: string;
}) {
  const hasSecondary = rows.some((row) => row.secondary != null);
  const chartConfig = {
    value: { label: valueLabel, color: valueColor },
    compare: { label: secondaryLabel, color: secondaryColor },
  } satisfies ChartConfig;
  if (rows.length === 0) {
    return (
      <EmptyState
        title={title}
        description="Для графика не хватает наблюдений в текущих фильтрах."
      />
    );
  }
  const data = rows.map((row) => ({
    label: row.label,
    value: row.value,
    compare: row.secondary ?? 0,
  }));
  const peak = Math.max(1, ...data.map((row) => Math.max(row.value, row.compare)));
  const height = compact ? 260 : rows.length * (hasSecondary ? 72 : 64) + 40;
  const minWidth = compact ? Math.max(560, rows.length * 28) : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className={compact ? 'overflow-x-auto' : undefined}>
          <ChartContainer
            config={chartConfig}
            initialDimension={{ width: minWidth ?? 640, height }}
            className="aspect-auto w-full"
            style={{ height, minWidth }}
          >
            <RechartsBarChart
              accessibilityLayer
              data={data}
              layout={compact ? 'horizontal' : 'vertical'}
              margin={
                compact
                  ? { left: 0, right: 8, top: 8, bottom: 0 }
                  : { left: 4, right: 48, top: 8, bottom: 4 }
              }
              barGap={compact ? 1 : 4}
            >
              <CartesianGrid horizontal={compact} vertical={false} stroke="var(--border)" />
              {compact ? (
                <XAxis
                  dataKey="label"
                  interval={0}
                  angle={-90}
                  textAnchor="end"
                  height={78}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'var(--foreground)', fontSize: 11 }}
                />
              ) : (
                <XAxis
                  type="number"
                  domain={[0, peak]}
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value: number) => formatChartNumber(value)}
                />
              )}
              {compact ? (
                <YAxis
                  width={36}
                  domain={[0, peak]}
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'var(--foreground)', fontSize: 11 }}
                  tickFormatter={(value: number) => formatChartNumber(value)}
                />
              ) : (
                <YAxis
                  type="category"
                  dataKey="label"
                  width={188}
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  tick={{ fill: 'var(--foreground)', fontSize: 12 }}
                />
              )}
              <ChartTooltip
                cursor={{ fill: 'var(--muted)' }}
                content={<ChartTooltipContent indicator="line" />}
              />
              {hasSecondary ? (
                <ChartLegend
                  verticalAlign={compact ? 'top' : 'bottom'}
                  content={<ChartLegendContent />}
                />
              ) : null}
              <Bar
                dataKey="value"
                fill="var(--color-value)"
                radius={compact ? [3, 3, 0, 0] : 4}
                barSize={compact ? undefined : 16}
              >
                {compact
                  ? null
                  : rows.map((row) => (
                      <Cell key={row.label} fill={row.color ?? 'var(--color-value)'} />
                    ))}
                {compact ? null : <LabelList dataKey="value" content={BarValueLabel} />}
              </Bar>
              {hasSecondary ? (
                <Bar
                  dataKey="compare"
                  fill="var(--color-compare)"
                  radius={compact ? [3, 3, 0, 0] : 4}
                  barSize={compact ? undefined : 16}
                >
                  {compact ? null : <LabelList dataKey="compare" content={BarValueLabel} />}
                </Bar>
              ) : null}
            </RechartsBarChart>
          </ChartContainer>
        </div>
        <div className={compact ? 'max-h-44 overflow-y-auto' : undefined}>
          <Table>
            <caption className="sr-only">Таблица для графика {title}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Сегмент</TableHead>
                <TableHead>{valueLabel}</TableHead>
                {hasSecondary ? <TableHead>{secondaryLabel}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.label}-table`}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell>{formatChartNumber(row.value)}</TableCell>
                  {hasSecondary ? (
                    <TableCell>{formatChartNumber(row.secondary ?? 0)}</TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function SimpleTable({
  title,
  columns,
  rows,
  empty,
  description,
}: {
  title: string;
  columns: string[];
  rows: string[][];
  empty: string;
  description?: string;
}) {
  if (rows.length === 0) return <EmptyState title={title} description={empty} />;
  return (
    <div className="overflow-x-auto rounded-[10px] border">
      <table className="w-full min-w-[480px] text-sm">
        <caption className="px-3 py-2 text-left">
          <span className="font-medium">{title}</span>
          {description ? (
            <span className="mt-1 block font-normal text-muted-foreground">{description}</span>
          ) : null}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} className="px-3 py-2 text-left">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${title}-${index}`} className="border-t">
              {row.map((cell, cellIndex) => (
                <td
                  key={`${cell}-${cellIndex}`}
                  className="max-w-64 truncate px-3 py-2"
                  title={cell}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricButton({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="min-h-11 rounded-[10px] border bg-card p-3 text-left"
      onClick={onClick}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </button>
  );
}

function formatMoney(amount: string | null): string {
  if (amount == null || !/^-?\d+(\.\d{1,2})?$/.test(amount)) {
    return 'Нет подтверждённых данных';
  }
  const negative = amount.startsWith('-');
  const [whole, fraction = ''] = amount.slice(negative ? 1 : 0).split('.');
  const grouped = (whole || '0').replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  return `${negative ? '−' : ''}${grouped},${fraction.padEnd(2, '0')} BYN`;
}

function formatRate(value: number | null): string {
  if (value == null) return 'Нет данных';
  return `${(value * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}

function formatDuration(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'Нет данных';
  if (value < 0) return 'Некорректная последовательность событий';
  const days = value / 86_400_000;
  return `${days.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} дн.`;
}
