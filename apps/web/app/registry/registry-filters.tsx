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
import { ScrollArea } from '@/components/ui/scroll-area';
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
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="w-full lg:w-[360px] xl:w-[400px]">
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
        <div className="hidden min-w-0 flex-1 grid-cols-3 gap-2 md:grid">
          <MultiSelect
            label="Статус"
            options={options?.statuses ?? []}
            values={query.statuses}
            onChange={(statuses) =>
              onChange({ ...query, page: 1, statuses: statuses as RegistryListQuery['statuses'] })
            }
          />
          <MultiSelect
            label="Объект"
            options={options?.objects ?? []}
            values={query.objectIds}
            onChange={(objectIds) => onChange({ ...query, page: 1, objectIds })}
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
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <Button type="button" variant="outline" onClick={() => onSheetOpenChange(true)}>
            <SlidersHorizontal data-icon="inline-start" />
            Фильтры
            {active > 0 ? (
              <Badge variant="secondary" className="ml-1">
                {active}
              </Badge>
            ) : null}
          </Button>
          {active > 0 ? (
            <Button type="button" variant="ghost" onClick={onReset}>
              Сбросить
            </Button>
          ) : null}
          {typeof resultCount === 'number' ? (
            <p className="text-sm text-muted-foreground">Найдено: {resultCount}</p>
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
          className="flex w-full flex-col sm:max-w-[480px]"
          showCloseButton
        >
          <SheetHeader>
            <SheetTitle>Фильтры</SheetTitle>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1 px-4">
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
          </ScrollArea>
          <SheetFooter className="border-t">
            <div className="flex w-full items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">Активных фильтров: {active}</p>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={onReset} disabled={active === 0}>
                  Сбросить все фильтры
                </Button>
                <Button type="button" onClick={() => onSheetOpenChange(false)}>
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
