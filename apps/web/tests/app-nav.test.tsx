import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppNav } from '../app/app-nav';

const pathname = vi.hoisted(() => ({ value: '/registry' }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.value,
}));

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
  pathname.value = '/registry';
  cleanup();
});

describe('AppNav presentation', () => {
  it('keeps administration pages in a dropdown for desktop ADMIN', async () => {
    const user = userEvent.setup();
    render(<AppNav role="ADMIN" />);
    expect(screen.getByRole('link', { name: 'Реестр' })).toHaveClass('whitespace-nowrap');
    expect(screen.getByRole('link', { name: 'Контроль сроков' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Пользователи' })).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'Администрирование' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: 'Пользователи' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Журнал аудита' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Состояние системы' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Администраторы' })).not.toBeInTheDocument();
  });

  it('marks administration current on nested routes', () => {
    pathname.value = '/system-status';
    render(<AppNav role="ADMIN" />);
    expect(screen.getByRole('button', { name: 'Администрирование' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('hides administration when the role has no admin pages', () => {
    render(<AppNav role="CONTRACTOR_ENGINEER" />);
    expect(screen.queryByRole('button', { name: 'Администрирование' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Реестр' })).toBeInTheDocument();
  });

  it('groups administration links in the drawer', () => {
    render(<AppNav role="SUPER_ADMIN" variant="drawer" />);
    expect(screen.getByText('Администрирование')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Пользователи' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Администраторы' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Журнал аудита' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Состояние системы' })).toBeInTheDocument();
  });
});
