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
import { navItemsForRole } from '../lib/app-nav';
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
  it('renders an accessible SVG mark with brand tokens and no raster image', () => {
    const { container } = render(<QcLogo href="/registry" />);
    expect(screen.getByRole('link', { name: 'QC.Dana' })).toHaveAttribute('href', '/registry');
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).toContain('var(--brand-q)');
    expect(container.innerHTML).toContain('var(--brand-c)');
    expect(container.innerHTML).not.toContain('.png');
    expect(container.querySelectorAll('rect')).toHaveLength(4);
    expect(container.querySelector('circle')).toBeTruthy();
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
  it('hides unavailable items', () => {
    const admin = navItemsForRole('ADMIN').map((item) => item.label);
    const responsible = navItemsForRole('RESPONSIBLE_ENGINEER').map((item) => item.label);
    expect(admin).toEqual([
      'Реестр',
      'Создать акт',
      'Контроль сроков',
      'Справочники',
      'Пользователи',
      'Состояние системы',
    ]);
    expect(responsible).toEqual(['Реестр', 'Контроль сроков']);
  });
});

const sampleRow: RegistryDefectRow = {
  rowId: 'r1',
  actId: 'act-1',
  defectItemId: 'd1',
  formCode: 'S1',
  formLabel: 'С-1',
  actNumber: 'С-1-000001',
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
  proposalA: null,
  documentRef: null,
};

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
    render(<RegistryCards rows={[sampleRow]} onOpen={() => undefined} />);
    expect(document.querySelector('.defect-card')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Открыть' })).toBeInTheDocument();
  });

  it('keeps date-only values from date inputs', () => {
    const onChange = vi.fn();
    render(<DateRange label="Плановый срок" from="2026-03-01" to={null} onChange={onChange} />);
    const from = screen.getByLabelText('с');
    expect((from as HTMLInputElement).value).toBe('2026-03-01');
    fireEvent.change(from, { target: { value: '2026-04-02' } });
    expect(onChange).toHaveBeenCalledWith('2026-04-02', null);
  });
});
