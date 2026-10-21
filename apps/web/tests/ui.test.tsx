import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRegistryListQuery } from '@sgr-registry/domain';
import { FilterChips } from '../components/filter-chips';
import { MultiSelect } from '../components/multi-select';
import { ConflictDialog } from '../components/conflict-dialog';
import { EmptyState, ErrorState, TableSkeleton } from '../components/states';
import { QcLogo } from '../components/qc-logo';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { DateRange } from '../app/registry/registry-filters';
import { RegistryTable } from '../app/registry/registry-table';
import { RegistryCards } from '../app/registry/registry-cards';
import { ProposalValue } from '../components/proposal-value';
import { navItemsForRole, navSectionsForRole } from '../lib/app-nav';
import { buildRegistryFilterChips } from '../lib/filter-chips';
import { TooltipProvider } from '../components/ui/tooltip';
import type { RegistryDefectRow } from '@sgr-registry/contracts';

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
});

describe('QcLogo', () => {
  it('renders the brand SVG file without a raster PNG', () => {
    const { container } = render(<QcLogo href="/registry" />);
    expect(screen.getByRole('link', { name: 'QC.Dana' })).toHaveAttribute('href', '/registry');
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', '/qc-logo.svg');
    expect(image).toHaveAttribute('aria-hidden', 'true');
    expect(container.innerHTML).not.toContain('.png');
  });

  it('uses an img role and label when the mark is not a link', () => {
    render(<QcLogo size="login" />);
    expect(screen.getByRole('img', { name: 'QC.Dana' })).toBeInTheDocument();
  });
});

describe('Button variants', () => {
  it('renders default, outline and ghost variants', () => {
    const { rerender } = render(<Button>Сохранить</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'default');
    rerender(<Button variant="outline">Отмена</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'outline');
    rerender(<Button variant="ghost">Ещё</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'ghost');
  });
});

describe('Badge status variants', () => {
  it('maps success warning error and info', () => {
    const { rerender } = render(<Badge variant="success">Исполнено</Badge>);
    expect(screen.getByText('Исполнено')).toHaveAttribute('data-variant', 'success');
    rerender(<Badge variant="warning">В работе</Badge>);
    expect(screen.getByText('В работе')).toHaveAttribute('data-variant', 'warning');
    rerender(<Badge variant="error">Просрочено</Badge>);
    expect(screen.getByText('Просрочено')).toHaveAttribute('data-variant', 'error');
    rerender(<Badge variant="info">В работе</Badge>);
    expect(screen.getByText('В работе')).toHaveAttribute('data-variant', 'info');
  });
});

describe('RegistryFilters toolbar layout', () => {
  it('aligns desktop controls with a named grid and visible labels', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../app/registry/registry-filters.tsx'),
      'utf8',
    );
    const toolbar = source.slice(
      source.indexOf('data-slot="registry-toolbar"'),
      source.indexOf('<FilterChips'),
    );
    expect(toolbar).toContain('md:items-end');
    expect(toolbar).toContain('[grid-area:search]');
    expect(toolbar).toContain('[grid-area:status]');
    expect(toolbar).toContain('[grid-area:object]');
    expect(toolbar).toContain('[grid-area:deadline]');
    expect(toolbar).toContain('[grid-area:actions]');
    expect(toolbar).toContain('md:self-end');
    expect(toolbar).toContain('flex h-11 shrink-0 items-center');
    expect(toolbar).toContain('label="Статус"');
    expect(toolbar).toContain('label="Объект"');
    expect(toolbar).toContain('label="Состояние срока"');
    expect(toolbar).not.toContain('hideLabel');
    expect(toolbar).not.toContain('absolute');
    expect(toolbar).not.toMatch(/-mt-| -top-|top-\[/);
    expect(toolbar).not.toContain('placeholder="Статус"');
  });
});

describe('MultiSelect', () => {
  const options = [
    { id: 'a', label: 'В работе' },
    { id: 'b', label: 'Исполнено' },
    { id: 'c', label: 'Северный квартал' },
  ];

  it('is closed by default', () => {
    render(<MultiSelect label="Статус" options={options} values={[]} onChange={() => undefined} />);
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Статус' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByText('Статус')).toBeInTheDocument();
  });

  it('can hide the visible label for a single-line toolbar', () => {
    const { container } = render(
      <MultiSelect
        label="Статус"
        placeholder="Статус"
        hideLabel
        options={options}
        values={[]}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Статус' })).toBeInTheDocument();
    expect(container.querySelector('span.font-medium')).toBeNull();
  });

  it('shows selected state', async () => {
    const user = userEvent.setup();
    render(
      <MultiSelect label="Статус" options={options} values={['a']} onChange={() => undefined} />,
    );
    expect(screen.getByRole('combobox')).toHaveTextContent('В работе');
    await user.click(screen.getByRole('combobox'));
    const option = screen.getByRole('option', { name: 'В работе' });
    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(option.className).toContain('justify-start');
    expect(window.getComputedStyle(option).textAlign || option.className).toMatch(
      /text-left|justify-start/,
    );
  });

  it('selects every option and clears the selection', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <MultiSelect label="Статус" options={options} values={[]} onChange={onChange} />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Статус' }));
    expect(screen.getByRole('button', { name: 'Сбросить: Статус' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Выбрать все: Статус' }));
    expect(onChange).toHaveBeenCalledWith(['a', 'b', 'c']);

    rerender(
      <MultiSelect label="Статус" options={options} values={['a', 'b', 'c']} onChange={onChange} />,
    );
    expect(screen.getByRole('button', { name: 'Выбрать все: Статус' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Сбросить: Статус' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('supports keyboard open, search and escape', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MultiSelect label="Объект" options={options} values={[]} onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Объект' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('option', { name: 'Северный квартал' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('option')).toBeNull();
  });
});

describe('checkbox control size', () => {
  it('does not stretch checkbox inputs to full width', () => {
    render(<Input type="checkbox" aria-label="Выбрать" />);
    const box = screen.getByLabelText('Выбрать');
    expect(box.className).toMatch(/size-4/);
    expect(box.className).toMatch(/max-h-\[18px\]/);
    expect(box.className).not.toMatch(/\bw-full\b/);
  });
});

describe('filter chips', () => {
  it('builds chips and removes a filter', async () => {
    const query = {
      ...parseRegistryListQuery({}),
      statuses: ['IN_PROGRESS' as const],
      objectIds: ['o1', 'o2'],
    };
    const chips = buildRegistryFilterChips(query, {
      formCodes: [],
      statuses: [{ id: 'IN_PROGRESS', label: 'В работе' }],
      objects: [
        { id: 'o1', label: 'A' },
        { id: 'o2', label: 'B' },
      ],
      defectTypes: [],
      customers: [],
      liableOrganizations: [],
      responsibleEngineers: [],
    });
    expect(chips.some((chip) => chip.label === 'Статус: В работе')).toBe(true);
    expect(chips.some((chip) => chip.label === 'Объект: 2')).toBe(true);
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(<FilterChips chips={chips} onRemove={onRemove} />);
    await user.click(screen.getByRole('button', { name: 'Удалить фильтр Статус: В работе' }));
    expect(onRemove).toHaveBeenCalled();
  });
});

describe('role-aware navigation', () => {
  it('hides unavailable items and groups administration pages', () => {
    const adminSections = navSectionsForRole('ADMIN');
    const admin = navItemsForRole('ADMIN').map((item) => item.label);
    const responsible = navItemsForRole('RESPONSIBLE_ENGINEER').map((item) => item.label);
    const contractor = navItemsForRole('CONTRACTOR_ENGINEER').map((item) => item.label);
    expect(adminSections.primary.map((item) => item.label)).toEqual([
      'Реестр',
      'Аналитика',
      'Объекты',
      'Создать акт',
      'Контроль сроков',
      'Уведомления',
      'Справочники',
    ]);
    expect(adminSections.administration.map((item) => item.label)).toEqual([
      'Пользователи',
      'Журнал аудита',
      'Состояние системы',
    ]);
    expect(admin).toEqual([
      'Реестр',
      'Аналитика',
      'Объекты',
      'Создать акт',
      'Контроль сроков',
      'Уведомления',
      'Справочники',
      'Пользователи',
      'Журнал аудита',
      'Состояние системы',
    ]);
    expect(navItemsForRole('MANAGER').map((item) => item.label)).toEqual(admin);
    expect(navItemsForRole('MANAGER').map((item) => item.href)).not.toContain('/super-admin');
    expect(navSectionsForRole('SGR_MANAGER').administration.map((item) => item.label)).toEqual([
      'Пользователи',
      'Журнал аудита',
    ]);
    expect(navSectionsForRole('SGR_MANAGER').administration.map((item) => item.href)).toContain(
      '/users',
    );
    expect(responsible).toEqual([
      'Реестр',
      'Объекты',
      'Создать акт',
      'Контроль сроков',
      'Уведомления',
      'Справочники',
    ]);
    expect(navSectionsForRole('RESPONSIBLE_ENGINEER').administration).toEqual([]);
    expect(contractor).toEqual(['Реестр', 'Контроль сроков', 'Уведомления', 'Справочники']);
    expect(contractor).toContain('Справочники');
    expect(contractor).not.toContain('Объекты');
    expect(contractor).not.toContain('Создать акт');
    expect(navSectionsForRole('CONTRACTOR_ENGINEER').administration).toEqual([]);
    expect(navSectionsForRole('SUPER_ADMIN').primary.map((item) => item.label)).toEqual([
      'Реестр',
      'Аналитика',
      'Объекты',
      'Создать акт',
      'Контроль сроков',
      'Уведомления',
      'Справочники',
    ]);
    expect(navSectionsForRole('SUPER_ADMIN').administration.map((item) => item.label)).toEqual([
      'Пользователи',
      'Администраторы',
      'Журнал аудита',
      'Состояние системы',
    ]);
    expect(navItemsForRole('SUPER_ADMIN').map((item) => item.href)).toContain('/registry');
    expect(navItemsForRole('SUPER_ADMIN').map((item) => item.href)).toContain('/acts/new');
    const allHrefs = navItemsForRole('ADMIN').map((item) => item.href);
    expect(new Set(allHrefs).size).toBe(allHrefs.length);
    expect(navItemsForRole('PENDING_ROLE')).toEqual([]);
  });
});

describe('history access in the act card', () => {
  it('renders the history tab only when canViewHistory is true', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../app/acts/[actId]/act-detail.tsx'),
      'utf8',
    );
    expect(source).toContain('canViewHistory(user.role)');
    expect(source).toContain('{showHistory ? <TabsTrigger value="history"');
    expect(source).toContain('{showHistory ? (');
    const logout = readFileSync(resolve(import.meta.dirname, '../lib/logout.ts'), 'utf8');
    expect(logout).toContain('queryClient.clear()');
    expect(logout).not.toContain('localStorage');
    expect(logout).not.toContain('sessionStorage');
  });
});

const sampleRow: RegistryDefectRow = {
  rowId: 'r1',
  actId: 'act-1',
  defectItemId: 'd1',
  formCode: 'S1',
  formLabel: 'С-1',
  actNumber: 'С-1-000001',
  actStatus: 'IN_PROGRESS',
  actStatusLabel: 'В работе',
  defectStatus: 'IN_PROGRESS',
  defectStatusLabel: 'В работе',
  objectName: 'Объект',
  objectId: 'obj-1',
  objectAddress: 'Адрес',
  location: 'Помещение',
  defectTypeId: 'type-1',
  defectTypeName: 'Течь',
  customerOrganizationId: 'cust-1',
  customerName: 'Заказчик',
  liableOrganizations: [{ id: '1', name: 'Подрядчик' }],
  responsibleEngineers: [{ id: '2', fullName: 'Инженер' }],
  plannedDeadline: '2026-01-01',
  claimDeadline: null,
  effectiveDeadline: '2026-01-01',
  deadlineState: 'NORMAL',
  deadlineStateLabel: 'В срок',
  readyAt: null,
  proposalA: {
    slot: 'A',
    amount: '1250.00',
    currency: 'BYN',
    contractorName: 'ООО «СтройСервис»',
  },
  documentRef: null,
};

const longOrg =
  'ООО «Очень длинное наименование альтернативной организации для проверки сокращения в ячейке реестра»';

describe('RESPONSIBLE has no B/C controls', () => {
  it('does not render B/C toggle', () => {
    render(
      <TooltipProvider>
        <RegistryTable
          rows={[sampleRow]}
          canViewBC={false}
          expandBC={false}
          onToggleBC={() => undefined}
          onOpen={() => undefined}
          sortBy="effectiveDeadline"
          sortDirection="asc"
          onSort={() => undefined}
          loading={false}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByRole('button', { name: /предложения B и C/ })).toBeNull();
    expect(screen.queryByText('Предложение B')).toBeNull();
    expect(screen.getByText('ООО «СтройСервис»')).toBeInTheDocument();
    expect(screen.getByText('1 250,00 BYN')).toBeInTheDocument();
  });
});

describe('proposal display', () => {
  it('shows organization and BYN amount, dash when empty, and tooltip for long names', () => {
    const { rerender } = render(
      <TooltipProvider>
        <ProposalValue
          proposal={{
            contractorName: longOrg,
            amount: '1250.00',
            currency: 'BYN',
          }}
        />
      </TooltipProvider>,
    );
    const name = screen.getByText(longOrg);
    expect(name.className).toMatch(/truncate/);
    expect(name.className).toMatch(/font-medium/);
    expect(name.getAttribute('data-slot')).toBe('tooltip-trigger');
    expect(screen.getByText('1 250,00 BYN')).toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <ProposalValue proposal={null} />
      </TooltipProvider>,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0,00 BYN')).toBeNull();
  });

  it('keeps archived organization names on historical proposals', () => {
    render(
      <TooltipProvider>
        <ProposalValue
          proposal={{
            contractorName: 'ООО «Архивная организация»',
            amount: '640.00',
            currency: 'BYN',
          }}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText('ООО «Архивная организация»')).toBeInTheDocument();
    expect(screen.getByText('640,00 BYN')).toBeInTheDocument();
  });

  it('renders A/B/C columns without splitting organization and amount', () => {
    render(
      <TooltipProvider>
        <RegistryTable
          rows={[
            {
              ...sampleRow,
              proposalsBC: [
                {
                  slot: 'B',
                  amount: '1180.50',
                  currency: 'BYN',
                  contractorName: 'ООО «Альтернатива Б» (демо)',
                },
                {
                  slot: 'C',
                  amount: '1310.00',
                  currency: 'BYN',
                  contractorName: 'ООО «Альтернатива В» (демо)',
                },
              ],
            },
          ]}
          canViewBC
          expandBC
          onToggleBC={() => undefined}
          onOpen={() => undefined}
          sortBy="effectiveDeadline"
          sortDirection="asc"
          onSort={() => undefined}
          loading={false}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText('Предложение А')).toBeInTheDocument();
    expect(screen.getByText('Предложение B')).toBeInTheDocument();
    expect(screen.getByText('Предложение C')).toBeInTheDocument();
    expect(screen.queryByText('Организация')).toBeNull();
    expect(screen.getByText('ООО «СтройСервис»')).toBeInTheDocument();
    expect(screen.getByText('1 250,00 BYN')).toBeInTheDocument();
    expect(screen.getByText('ООО «Альтернатива Б» (демо)')).toBeInTheDocument();
    expect(screen.getByText('1 180,50 BYN')).toBeInTheDocument();
  });
});

describe('states', () => {
  it('renders loading skeleton, empty and error', async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<TableSkeleton />);
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    rerender(
      <EmptyState title="Нет строк" description="По текущим условиям нет доступных дефектов." />,
    );
    expect(screen.getByRole('heading', { name: 'Нет строк' })).toBeInTheDocument();
    rerender(<ErrorState description="Не удалось загрузить реестр." onRetry={retry} />);
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(retry).toHaveBeenCalled();
  });

  it('renders stale conflict dialog', async () => {
    const refresh = vi.fn();
    const user = userEvent.setup();
    render(<ConflictDialog open onRefresh={refresh} onOpenChange={() => undefined} />);
    expect(screen.getByText('Данные уже изменены')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Обновить данные' }));
    expect(refresh).toHaveBeenCalled();
  });
});

describe('mobile cards and date-only value', () => {
  it('renders defect cards instead of relying on the desktop table', () => {
    render(<RegistryCards rows={[sampleRow]} canViewBC={false} onOpen={() => undefined} />);
    expect(document.querySelector('.defect-card')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Открыть' })).toBeInTheDocument();
    expect(screen.getByText('Предложение А')).toBeInTheDocument();
    expect(screen.getByText('ООО «СтройСервис»')).toBeInTheDocument();
    expect(screen.getByText('1 250,00 BYN')).toBeInTheDocument();
    expect(screen.queryByText('Предложение B')).toBeNull();
  });

  it('shows separate organization and amount lines for available A/B/C slots', () => {
    render(
      <RegistryCards
        rows={[
          {
            ...sampleRow,
            proposalsBC: [
              {
                slot: 'B',
                amount: '1180.50',
                currency: 'BYN',
                contractorName: 'ООО «Альтернатива Б» (демо)',
              },
            ],
          },
        ]}
        canViewBC
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByText('Предложение А')).toBeInTheDocument();
    expect(screen.getByText('Предложение B')).toBeInTheDocument();
    expect(screen.queryByText('Предложение C')).toBeNull();
    const amount = screen.getByText('1 250,00 BYN');
    expect(amount.previousElementSibling).toHaveTextContent('ООО «СтройСервис»');
  });

  it('proposal editor keeps shadcn Select and submits organizationId', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../app/acts/[actId]/act-operations.tsx'),
      'utf8',
    );
    const editor = source.slice(source.indexOf('function ProposalEditor'));
    expect(editor).toContain('label="Организация"');
    expect(editor).toContain('alternativeContractorOrganizationId: organizationId');
    expect(editor).toContain('currentProposal?.contractorName');
    expect(editor).toContain('DirectoryCombobox');
    expect(editor).not.toMatch(/<select[\s>]/);
  });

  it('keeps date-only values from date inputs', () => {
    const onChange = vi.fn();
    render(<DateRange label="Срок устранения" from="2026-03-01" to={null} onChange={onChange} />);
    const from = screen.getByLabelText('с');
    expect((from as HTMLInputElement).value).toBe('2026-03-01');
    fireEvent.change(from, { target: { value: '2026-04-02' } });
    expect(onChange).toHaveBeenCalledWith('2026-04-02', null);
  });
});
