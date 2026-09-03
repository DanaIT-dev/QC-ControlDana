import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_FOOTER_CREDIT, AppFooter } from '../components/app-footer';

afterEach(() => {
  cleanup();
});

describe('AppFooter', () => {
  it('renders the exact credit as compact non-link text', () => {
    render(<AppFooter />);
    const footer = screen.getByRole('contentinfo');
    expect(footer.tagName).toBe('FOOTER');
    expect(footer).toHaveTextContent(APP_FOOTER_CREDIT);
    expect(APP_FOOTER_CREDIT).toBe('Inspired by Andrew Rodkevich');
    expect(screen.queryByRole('link', { name: APP_FOOTER_CREDIT })).not.toBeInTheDocument();
    expect(footer.querySelector('p')).toHaveClass('whitespace-nowrap');
  });
});
