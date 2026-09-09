'use client';

import type { RegistryFilterOption } from '@sgr-registry/contracts';
import { countActiveRegistryFilters, type RegistryListQuery } from '@sgr-registry/domain';
import { SlidersHorizontal } from 'lucide-react';
import { FilterChips } from '@/components/filter-chips';
import { MultiSelect } from '@/components/multi-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { buildRegistryFilterChips, type RegistryFilterOptions } from '@/lib/filter-chips';

const DEADLINE_OPTIONS: RegistryFilterOption[] = [
  { id: 'NO_DEADLINE', label: 'Срок не установлен' },
  { id: 'NORMAL', label: 'В срок' },
  { id: 'WARNING', label: 'Срок приближается' },
  { id: 'OVERDUE', label: 'Просрочено' },
  { id: 'COMPLETED', label: 'Исполнено' },
];

export function RegistryFilters({
  query,
  options,
  searchDraft,
  onSearchDraft,
  onSearchSubmit,
  onChange,
  onReset,
  sheetOpen,
  onSheetOpenChange,
  resultCount,
}: {
  query: RegistryListQuery;
  options: RegistryFilterOptions | null;
  searchDraft: string;
  onSearchDraft: (value: string) => void;
  onSearchSubmit: () => void;
  onChange: (next: RegistryListQuery) => void;
  onReset: () => void;
  sheetOpen: boolean;
  onSheetOpenChange: (open: boolean) => void;
  resultCount?: number;
}) {
  const active = countActiveRegistryFilters(query);
  const chips = buildRegistryFilterChips(query, options);

  return (
    <div className="grid gap-3">
      <div
        data-slot="registry-toolbar"
        className="flex flex-col gap-3 md:grid md:grid-cols-6 md:items-end md:gap-2 md:[grid-template-areas:'search_search_search_search_actions_actions'_'status_status_object_object_deadline_deadline'] xl:grid-cols-[minmax(16rem,1.4fr)_repeat(3,minmax(10.5rem,1fr))_auto] xl:[grid-template-areas:'search_status_object_deadline_actions']"
      >
        <div className="flex min-w-0 items-end [grid-area:search]">
          <Input
            value={searchDraft}
            onChange={(event) => onSearchDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onSearchSubmit();
              }
            }}
            placeholder="Номер акта, объект, адрес, заказчик…"
            aria-label="Поиск"
          />
        </div>
        <div className="hidden min-w-0 [grid-area:status] md:block">
          <MultiSelect
            label="Статус"
            options={options?.statuses ?? []}
            values={query.statuses}
            onChange={(statuses) =>
              onChange({ ...query, page: 1, statuses: statuses as RegistryListQuery['statuses'] })
            }
          />
        </div>
        <div className="hidden min-w-0 [grid-area:object] md:block">
          <MultiSelect
            label="Объект"
            options={options?.objects ?? []}
            values={query.objectIds}
            onChange={(objectIds) => onChange({ ...query, page: 1, objectIds })}
          />
        </div>
        <div className="hidden min-w-0 [grid-area:deadline] md:block">
          <MultiSelect
            label="Состояние срока"
            options={DEADLINE_OPTIONS}
            values={query.deadlineState}
            onChange={(deadlineState) =>
              onChange({
                ...query,
                page: 1,
                deadlineState: deadlineState as RegistryListQuery['deadlineState'],
              })
            }
          />
        </div>
        <div className="flex shrink-0 items-end gap-2 md:self-end [grid-area:actions]">
          <Button
            type="button"
            variant="outline"
            className="h-11 shrink-0"
            onClick={() => onSheetOpenChange(true)}
          >
            <SlidersHorizontal data-icon="inline-start" />
            Фильтры
            {active > 0 ? (
              <Badge variant="secondary" className="ml-1">
                {active}
              </Badge>
            ) : null}
          </Button>
          {active > 0 ? (
            <Button type="button" variant="ghost" className="h-11 shrink-0" onClick={onReset}>
              Сбросить
            </Button>
          ) : null}
          {typeof resultCount === 'number' ? (
            <p className="flex h-11 shrink-0 items-center whitespace-nowrap text-sm text-muted-foreground">
              Найдено: {resultCount}
            </p>
          ) : null}
        </div>
      </div>
      <FilterChips
        chips={chips}
        onRemove={(chip) => onChange({ ...query, page: 1, ...chip.onRemoveQuery })}
      />
      <Sheet open={sheetOpen} onOpenChange={onSheetOpenChange}>
        <SheetContent
          side="right"
          className="flex h-[100dvh] max-h-[100dvh] w-full flex-col gap-0 overflow-hidden sm:max-w-[480px]"
          showCloseButton
        >
          <SheetHeader className="shrink-0">
            <SheetTitle>Фильтры</SheetTitle>
          </SheetHeader>
          <div data-slot="filter-sheet-body" className="min-h-0 flex-1 overflow-y-auto px-4">
            <div className="grid gap-6 pb-6">
              <section className="grid gap-3">
                <h3 className="text-sm font-semibold">Основное</h3>
                <MultiSelect
                  label="Форма"
                  options={options?.formCodes ?? []}
                  values={query.formCodes}
                  onChange={(formCodes) =>
                    onChange({
                      ...query,
                      page: 1,
                      formCodes: formCodes as RegistryListQuery['formCodes'],
                    })
                  }
                />
                <MultiSelect
                  label="Статус"
                  options={options?.statuses ?? []}
                  values={query.statuses}
                  onChange={(statuses) =>
                    onChange({
                      ...query,
                      page: 1,
                      statuses: statuses as RegistryListQuery['statuses'],
                    })
                  }
                />
                <MultiSelect
                  label="Объект"
                  options={options?.objects ?? []}
                  values={query.objectIds}
                  onChange={(objectIds) => onChange({ ...query, page: 1, objectIds })}
                />
                <MultiSelect
                  label="Вид дефекта"
                  options={options?.defectTypes ?? []}
                  values={query.defectTypeIds}
                  onChange={(defectTypeIds) => onChange({ ...query, page: 1, defectTypeIds })}
                />
              </section>
              <section className="grid gap-3">
                <h3 className="text-sm font-semibold">Участники</h3>
                <MultiSelect
                  label="Заказчик"
                  options={options?.customers ?? []}
                  values={query.customerOrganizationIds}
                  onChange={(customerOrganizationIds) =>
                    onChange({ ...query, page: 1, customerOrganizationIds })
                  }
                />
                <MultiSelect
                  label="Виновная организация"
                  options={options?.liableOrganizations ?? []}
                  values={query.liableOrganizationIds}
                  onChange={(liableOrganizationIds) =>
                    onChange({ ...query, page: 1, liableOrganizationIds })
                  }
                />
                <MultiSelect
                  label="Ответственный инженер"
                  options={options?.responsibleEngineers ?? []}
                  values={query.responsibleEngineerIds}
                  onChange={(responsibleEngineerIds) =>
                    onChange({ ...query, page: 1, responsibleEngineerIds })
                  }
                />
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <Checkbox
                    checked={query.unmatchedEngineers}
                    onCheckedChange={(checked) =>
                      onChange({ ...query, page: 1, unmatchedEngineers: checked === true })
                    }
                    aria-label="Инженеры не сопоставлены"
                  />
                  Инженеры не сопоставлены
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <Checkbox
                    checked={query.importedOnly}
                    onCheckedChange={(checked) =>
                      onChange({ ...query, page: 1, importedOnly: checked === true })
                    }
                    aria-label="Импортированные"
                  />
                  Импортированные
                </label>
              </section>
              <section className="grid gap-3">
                <h3 className="text-sm font-semibold">Сроки</h3>
                <DateRange
                  label="Плановый срок"
                  from={query.plannedDeadlineFrom}
                  to={query.plannedDeadlineTo}
                  onChange={(plannedDeadlineFrom, plannedDeadlineTo) =>
                    onChange({ ...query, page: 1, plannedDeadlineFrom, plannedDeadlineTo })
                  }
                />
                <DateRange
                  label="Срок по претензии"
                  from={query.claimDeadlineFrom}
                  to={query.claimDeadlineTo}
                  onChange={(claimDeadlineFrom, claimDeadlineTo) =>
                    onChange({ ...query, page: 1, claimDeadlineFrom, claimDeadlineTo })
                  }
                />
                <DateRange
                  label="Дата готовности"
                  from={query.readyAtFrom}
                  to={query.readyAtTo}
                  onChange={(readyAtFrom, readyAtTo) =>
                    onChange({ ...query, page: 1, readyAtFrom, readyAtTo })
                  }
                />
                <MultiSelect
                  label="Состояние срока"
                  options={DEADLINE_OPTIONS}
                  values={query.deadlineState}
                  onChange={(deadlineState) =>
                    onChange({
                      ...query,
                      page: 1,
                      deadlineState: deadlineState as RegistryListQuery['deadlineState'],
                    })
                  }
                />
              </section>
            </div>
          </div>
          <SheetFooter
            data-slot="filter-sheet-footer"
            className="mt-0 shrink-0 border-t pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            <div className="flex w-full flex-col gap-3">
              <p className="text-sm text-muted-foreground">Активных фильтров: {active}</p>
              <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  onClick={onReset}
                  disabled={active === 0}
                >
                  Сбросить все фильтры
                </Button>
                <Button type="button" className="min-h-11" onClick={() => onSheetOpenChange(false)}>
                  Показать результаты
                </Button>
              </div>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function DateRange({
  label,
  from,
  to,
  onChange,
}: {
  label: string;
  from: string | null;
  to: string | null;
  onChange: (from: string | null, to: string | null) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-[13px] font-medium">{label}</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${label}-from`}>с</Label>
          <Input
            id={`${label}-from`}
            type="date"
            value={from ?? ''}
            onChange={(event) => onChange(event.target.value || null, to)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${label}-to`}>по</Label>
          <Input
            id={`${label}-to`}
            type="date"
            value={to ?? ''}
            onChange={(event) => onChange(from, event.target.value || null)}
          />
        </div>
      </div>
    </fieldset>
  );
}
