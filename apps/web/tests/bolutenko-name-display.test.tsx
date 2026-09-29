import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonName } from '../components/person-name';
import { UserMenu } from '../components/user-menu';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

const parts = {
  lastName: 'Болутенко',
  firstName: 'Павел',
  middleName: null,
  fullName: 'Болутенко Павел',
};

describe('Bolutenko name display', () => {
  it('renders the surname-first short name in tables and the audit log', () => {
    const { container } = render(<PersonName {...parts} />);
    expect(container).toHaveTextContent('Болутенко П.');
    expect(container).not.toHaveTextContent('Павел Б.');
    expect(screen.getByLabelText('Болутенко Павел')).toBeVisible();
  });

  it('renders the surname-first short name in the user menu', () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <UserMenu
          user={{
            id: 'user-bolutenko',
            ...parts,
            email: 'user@example.sgr.local',
            role: 'ADMIN',
            roleLabel: 'Администратор',
            csrfToken: 'csrf-test-token',
            mustChangePassword: false,
          }}
        />
      </QueryClientProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Меню пользователя' });
    expect(trigger).toHaveTextContent('Болутенко П.');
    expect(trigger).not.toHaveTextContent('Павел Б.');
  });
});
