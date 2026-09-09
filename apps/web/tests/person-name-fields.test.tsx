import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonNameFields } from '../components/person-name-fields';

afterEach(() => {
  cleanup();
});

describe('PersonNameFields', () => {
  it('places last name and first name in one desktop row', () => {
    const { container } = render(
      <PersonNameFields
        idPrefix="new-user"
        lastName="Василевич"
        firstName="Михаил"
        middleName="Викторович"
        onLastNameChange={vi.fn()}
        onFirstNameChange={vi.fn()}
        onMiddleNameChange={vi.fn()}
      />,
    );
    const grid = container.firstElementChild;
    expect(grid?.className).toContain('sm:grid-cols-2');
    expect(grid?.className).toContain('items-start');
    expect(screen.getByLabelText('Фамилия')).toHaveValue('Василевич');
    expect(screen.getByLabelText('Имя')).toHaveValue('Михаил');
    expect(screen.getByLabelText('Отчество').closest('div')?.className).toContain('sm:col-span-2');
  });
});
