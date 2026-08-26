'use client';

import type { RegistryFilterOption } from '@sgr-registry/contracts';
import { countActiveRegistryFilters, type RegistryListQuery } from '@sgr-registry/domain';

export function RegistryFilters({
  query,
  options,
  searchDraft,
  onSearchDraft,
  onSearchSubmit,
  onChange,
  onReset,
  mobileOpen,
  onCloseMobile,
}: {
  query: RegistryListQuery;
  options: {
    formCodes: RegistryFilterOption[];
    statuses: RegistryFilterOption[];
    objects: RegistryFilterOption[];
    defectTypes: RegistryFilterOption[];
    customers: RegistryFilterOption[];
    liableOrganizations: RegistryFilterOption[];
    responsibleEngineers: RegistryFilterOption[];
  } | null;
  searchDraft: string;
  onSearchDraft: (value: string) => void;
  onSearchSubmit: () => void;
  onChange: (next: RegistryListQuery) => void;
  onReset: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const active = countActiveRegistryFilters(query);
  const body = (
    <div className="filter-grid">
      <label className="filter-field filter-field--search">
        <span>Поиск</span>
        <input
          value={searchDraft}
          onChange={(event) => onSearchDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSearchSubmit();
            }
          }}
          placeholder="Номер акта, объект, адрес, заказчик…"
        />
      </label>
      <MultiSelect
        label="Форма"
        options={options?.formCodes ?? []}
        values={query.formCodes}
        onChange={(formCodes) =>
          onChange({ ...query, page: 1, formCodes: formCodes as RegistryListQuery['formCodes'] })
        }
      />
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
        label="Вид дефекта"
        options={options?.defectTypes ?? []}
        values={query.defectTypeIds}
        onChange={(defectTypeIds) => onChange({ ...query, page: 1, defectTypeIds })}
      />
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
        onChange={(liableOrganizationIds) => onChange({ ...query, page: 1, liableOrganizationIds })}
      />
      <MultiSelect
        label="Ответственный инженер"
        options={options?.responsibleEngineers ?? []}
        values={query.responsibleEngineerIds}
        onChange={(responsibleEngineerIds) =>
          onChange({ ...query, page: 1, responsibleEngineerIds })
        }
      />
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
        options={[
          { id: 'NO_DEADLINE', label: 'Срок не установлен' },
          { id: 'NORMAL', label: 'В срок' },
          { id: 'WARNING', label: 'Срок приближается' },
          { id: 'OVERDUE', label: 'Просрочено' },
          { id: 'COMPLETED', label: 'Исполнено' },
        ]}
        values={query.deadlineState}
        onChange={(deadlineState) =>
          onChange({
            ...query,
            page: 1,
            deadlineState: deadlineState as RegistryListQuery['deadlineState'],
          })
        }
      />
      <div className="filter-actions">
        <p className="filter-count">Активных фильтров: {active}</p>
        <button type="button" className="ghost-button" onClick={onReset}>
          Сбросить все фильтры
        </button>
      </div>
    </div>
  );

  return (
    <>
      <section className="panel filters-panel filters-panel--desktop">{body}</section>
      {mobileOpen ? (
        <div className="filters-drawer" role="dialog" aria-label="Фильтры реестра">
          <div className="filters-drawer__panel">
            <div className="filters-drawer__head">
              <h2>Фильтры</h2>
              <button type="button" className="ghost-button" onClick={onCloseMobile}>
                Закрыть
              </button>
            </div>
            {body}
          </div>
        </div>
      ) : null}
    </>
  );
}

function MultiSelect({
  label,
  options,
  values,
  onChange,
}: {
  label: string;
  options: RegistryFilterOption[];
  values: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="filter-field">
      <legend>{label}</legend>
      <div className="filter-options">
        {options.length === 0 ? <p className="meta">Нет значений</p> : null}
        {options.map((option) => {
          const checked = values.includes(option.id);
          return (
            <label key={option.id} className="check-option">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => {
                  onChange(
                    checked ? values.filter((id) => id !== option.id) : [...values, option.id],
                  );
                }}
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function DateRange({
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
    <fieldset className="filter-field">
      <legend>{label}</legend>
      <div className="date-range">
        <label>
          <span>с</span>
          <input
            type="date"
            value={from ?? ''}
            onChange={(event) => onChange(event.target.value || null, to)}
          />
        </label>
        <label>
          <span>по</span>
          <input
            type="date"
            value={to ?? ''}
            onChange={(event) => onChange(from, event.target.value || null)}
          />
        </label>
      </div>
    </fieldset>
  );
}
