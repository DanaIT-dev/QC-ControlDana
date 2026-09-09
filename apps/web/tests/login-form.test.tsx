import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginForm } from '../app/login/login-form';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LoginForm', () => {
  it('disables native GET submit until the client handler is ready', () => {
    const html = renderToString(<LoginForm />);
    expect(html).toContain('method="post"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Войти<\/button>/);
  });

  it('prevents a native form reload and navigates after the first successful login', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: 'ADMIN', mustChangePassword: false }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginForm />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled();
    });
    fireEvent.change(screen.getByLabelText('Электронная почта'), {
      target: { value: 'alexey.viktorov@example.sgr.local' },
    });
    fireEvent.change(screen.getByLabelText('Пароль'), {
      target: { value: 'Dana-SGR-Demo-2026!' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith('/registry');
    });
  });
});
