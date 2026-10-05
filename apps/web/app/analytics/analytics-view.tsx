'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AnalyticsCosts,
  AnalyticsOverview,
  AnalyticsPatternCard,
} from '@sgr-registry/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, MetricSkeleton, TableSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
  reviewInsight,
} from '@/lib/analytics-api';
import { queryKeys } from '@/lib/query-keys';

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
  const suffix = search ? `?${search}` : '';
  const tab = params.get('tab') ?? 'overview';
  const overview = useQuery({
    queryKey: queryKeys.analytics.overview(search),
    queryFn: () => fetchAnalyticsOverview(suffix),
  });
  const filters = useQuery({
    queryKey: queryKeys.analytics.filters(search),
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
    update({ tab: 'drilldown', metric });
  }

  return (
    <div className="min-w-0">
      <PageHeader
        title="Аналитика"
        description="Качество, ответственность и подтверждённые потери. Показатели считаются на сервере в Europe/Minsk и не смешивают предложения с расходами."
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
          <CostsPane search={search} suffix={suffix} onOpen={openMetric} />
        </TabsContent>
        <TabsContent value="liability">
          <LiabilityPane search={search} suffix={suffix} />
        </TabsContent>
        <TabsContent value="process">
          <ProcessPane search={search} suffix={suffix} onOpen={openMetric} />
        </TabsContent>
        <TabsContent value="patterns">
          <PatternsPane search={search} suffix={suffix} csrfToken={csrfToken} onOpen={openMetric} />
        </TabsContent>
        <TabsContent value="data-quality">
          <QualityPane search={search} suffix={suffix} onOpen={openMetric} />
        </TabsContent>
        <TabsContent value="drilldown">
          <DrilldownPane
            search={search}
            suffix={suffix}
            page={params.get('page') ?? '1'}
            onPage={(page) => update({ page, tab: 'drilldown' })}
          />
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
  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-xs text-muted-foreground">
        Дата регистрации с
        <Input
          type="date"
          value={dateFrom}
          onChange={(event) => onChange({ dateFrom: event.target.value || null })}
        />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        Дата регистрации по
        <Input
          type="date"
          value={dateTo}
          onChange={(event) => onChange({ dateTo: event.target.value || null })}
        />
      </label>
      <label className="grid min-w-40 gap-1 text-xs text-muted-foreground">
        Объект
        <select
          className="h-11 rounded-md border bg-background px-2 text-sm text-foreground"
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
    [
      'Подтверждённые затраты Dana',
      data.financialVisible ? formatMoney(data.companyActualCostByn) : 'Недоступно',
      'companyActualCost',
    ],
    ['Открытый backlog', String(data.openDefects), 'openDefects'],
    ['Просрочено', String(data.overdueDefects), 'overdueDefects'],
    ['Медиана закрытия', formatDuration(data.medianClosureMs), 'closedInPeriod'],
    ['p90 закрытия', formatDuration(data.p90ClosureMs), 'closedInPeriod'],
    ['First-Time-Right', formatRate(data.firstTimeRight.rate), 'firstTimeRight'],
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
    <div className="grid gap-4">
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
      <BarChart
        title="Открыто и закрыто"
        rows={data.openedClosed.map((row) => ({
          label: row.period,
          value: row.opened,
          secondary: row.closed,
        }))}
      />
      <BarChart
        title="Возраст backlog"
        rows={data.backlogAge.map((row) => ({ label: row.bucket, value: row.count }))}
      />
      <SimpleTable
        title="Топ рисков"
        columns={['Дефект', 'Оценка']}
        rows={data.topRisks.map((row) => [
          row.label,
          row.score.toLocaleString('ru-RU', { maximumFractionDigits: 2 }),
        ])}
        empty="Нет открытых дефектов в текущем scope."
      />
      {data.financialVisible ? (
        <SimpleTable
          title="Организации по подтверждённому влиянию"
          columns={['Организация', 'BYN']}
          rows={data.topOrganizations.map((row) => [row.name, formatMoney(row.amountByn)])}
          empty="Нет подтверждённых затрат компании."
        />
      ) : null}
    </div>
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
          row.amountType,
          row.payerType,
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
              'First-Time-Right',
              'Rework',
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
        rows={data.funnel.map((row) => ({ label: row.label, value: row.count }))}
      />
      <SimpleTable
        title="Длительности"
        columns={['Показатель', 'Медиана', 'p75', 'p90', 'Выборка']}
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
        Время ожидания проверки не включается во время подрядчика. Назначение инженера не имеет
        отдельной метки времени, поэтому DetectionToAssignment не вычисляется.
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
        rows={data.aging.map((row) => ({ label: row.bucket, value: row.count }))}
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{item.displayLabel}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        <p>{item.plainLanguageExplanation}</p>
        <p>
          Выборка: {item.supportCount}. Базовый уровень: {formatRate(item.baselineValue)}.
          Достоверность: {item.confidence}. Статус: {item.status}.
        </p>
        <button
          type="button"
          className="min-h-11 w-fit underline"
          onClick={() => onOpen('defects')}
        >
          Открыть дефекты выборки
        </button>
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
    ['Без срока', data.missingDeadline, 'defects'],
    ['Без истории попыток', data.missingAttemptHistory, 'withoutAttempts'],
    ['Без финансовых данных', data.missingFinancialData, 'defects'],
    ['Несопоставленные инженеры', data.unresolvedEngineers, 'defects'],
    ['Импортированные записи', data.importedRecords, 'defects'],
    ['Неполные timestamps', data.incompleteTimestamps, 'defects'],
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
        модели, поэтому пропуск типа равен 0.
      </p>
      <SimpleTable
        title="Покрытие"
        columns={['Метрика', 'Покрыто', 'Всего']}
        rows={data.coverage.map((row) => [row.label, String(row.covered), String(row.total)])}
        empty="Нет дефектов."
      />
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
        description="Drill-down открывается из карточки KPI, строки или сигнала."
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
              {['Акт', 'Объект', 'Организации', 'Статус'].map((column) => (
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
                <td className="max-w-48 truncate px-2 py-2" title={item.objectName}>
                  {item.objectName}
                </td>
                <td
                  className="max-w-48 truncate px-2 py-2"
                  title={item.liableOrganizations.join(', ')}
                >
                  {item.liableOrganizations.join(', ') || '—'}
                </td>
                <td className="px-2 py-2">{item.status}</td>
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

function BarChart({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: number; secondary?: number }>;
}) {
  const max = Math.max(1, ...rows.map((row) => Math.max(row.value, row.secondary ?? 0)));
  if (rows.length === 0) {
    return (
      <EmptyState
        title={title}
        description="Для графика не хватает наблюдений в текущих фильтрах."
      />
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[6rem_1fr] items-center gap-2">
            <span className="truncate text-xs" title={row.label}>
              {row.label}
            </span>
            <button
              type="button"
              className="h-3 rounded-sm bg-[repeating-linear-gradient(90deg,#1f4b99_0_8px,#d7e2f5_8px_10px)]"
              style={{ width: `${Math.max(4, (row.value / max) * 100)}%` }}
              aria-label={`${row.label}: ${row.value}`}
              title={`${row.label}: ${row.value}`}
            />
          </div>
        ))}
        <table className="mt-2 w-full text-sm">
          <caption className="sr-only">Таблица для графика {title}</caption>
          <thead>
            <tr>
              <th className="text-left">Сегмент</th>
              <th className="text-left">Значение</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.label}-table`}>
                <td>{row.label}</td>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function SimpleTable({
  title,
  columns,
  rows,
  empty,
}: {
  title: string;
  columns: string[];
  rows: string[][];
  empty: string;
}) {
  if (rows.length === 0) return <EmptyState title={title} description={empty} />;
  return (
    <div className="overflow-x-auto rounded-[10px] border">
      <table className="w-full min-w-[480px] text-sm">
        <caption className="px-3 py-2 text-left font-medium">{title}</caption>
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
  if (amount == null) return 'Нет подтверждённых данных';
  const value = Number(amount);
  if (!Number.isFinite(value)) return 'Нет подтверждённых данных';
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} BYN`;
}

function formatRate(value: number | null): string {
  if (value == null) return 'Нет данных';
  return `${(value * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}

function formatDuration(value: number | null): string {
  if (value == null) return 'Нет данных';
  const days = value / 86_400_000;
  return `${days.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} дн.`;
}
