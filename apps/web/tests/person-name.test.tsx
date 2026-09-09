import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonName } from '../components/person-name';

afterEach(() => {
  cleanup();
});

describe('PersonName', () => {
  it('keeps surname and initials on one baseline without overflow on the root', () => {
    const { container } = render(<PersonName fullName="Василевич Михаил Викторович" />);
    const root = container.querySelector('[data-slot="person-name"]');
    expect(root).toBeTruthy();
    expect(root?.className).toContain('items-baseline');
    expect(root?.className).not.toContain('inline-block');
    expect(root?.className).not.toMatch(/\btruncate\b/);
    expect(root).toHaveTextContent('Василевич М.В.');
    const parts = root?.querySelectorAll(':scope > span') ?? [];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveTextContent('Василевич');
    expect(parts[1]).toHaveTextContent('М.В.');
  });

  it('splits abbreviated source names the same way', () => {
    render(<PersonName fullName="Василевич М.В." />);
    const root = screen.getByLabelText('Василевич М.В.');
    const parts = root.querySelectorAll(':scope > span');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveTextContent('Василевич');
    expect(parts[1]).toHaveTextContent('М.В.');
  });
});
