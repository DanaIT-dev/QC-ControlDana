import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { LinkedObjectFields } from '../components/linked-object-fields';

const OBJECTS = [
  { id: 'obj-a', name: 'ЖК «Альфа»', address: 'г. Минск, ул. Первая, 1' },
  { id: 'obj-b', name: 'ЖК «Альфа»', address: 'г. Минск, ул. Вторая, 2' },
  { id: 'obj-c', name: 'ЖК «Бета»', address: 'г. Минск, ул. Первая, 1' },
  {
    id: 'obj-archived',
    name: 'ЖК «Архив»',
    address: 'г. Минск, ул. Закрытая, 9',
    active: false,
  },
];

function Harness({ initialId = '' }: { initialId?: string }) {
  const [objectId, setObjectId] = useState(initialId);
  return (
    <div>
      <LinkedObjectFields objects={OBJECTS} objectId={objectId} onObjectIdChange={setObjectId} />
      <output data-testid="object-id">{objectId}</output>
    </div>
  );
}

afterEach(() => {
  cleanup();
});

describe('LinkedObjectFields', () => {
  it('fills address and objectId when a name is chosen', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('combobox', { name: 'Объект' }));
    await user.click(screen.getByRole('option', { name: /ул\. Вторая, 2/ }));
    expect(screen.getByTestId('object-id')).toHaveTextContent('obj-b');
    expect(screen.getByRole('combobox', { name: 'Объект' })).toHaveTextContent('ЖК «Альфа»');
    expect(screen.getByRole('combobox', { name: 'Адрес объекта' })).toHaveTextContent(
      'г. Минск, ул. Вторая, 2',
    );
  });

  it('fills name and objectId when an address is chosen', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('combobox', { name: 'Адрес объекта' }));
    await user.click(screen.getByRole('option', { name: /ЖК «Бета»/ }));
    expect(screen.getByTestId('object-id')).toHaveTextContent('obj-c');
    expect(screen.getByRole('combobox', { name: 'Объект' })).toHaveTextContent('ЖК «Бета»');
    expect(screen.getByRole('combobox', { name: 'Адрес объекта' })).toHaveTextContent(
      'г. Минск, ул. Первая, 1',
    );
  });

  it('switches both fields together and clears the canonical id', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('combobox', { name: 'Объект' }));
    await user.click(screen.getByRole('option', { name: /Альфа.*Первая/ }));
    expect(screen.getByTestId('object-id')).toHaveTextContent('obj-a');
    await user.click(screen.getByRole('combobox', { name: 'Адрес объекта' }));
    await user.click(screen.getByRole('option', { name: /Вторая, 2/ }));
    expect(screen.getByTestId('object-id')).toHaveTextContent('obj-b');
    expect(screen.getByRole('combobox', { name: 'Объект' })).toHaveTextContent('ЖК «Альфа»');
    expect(screen.getByRole('combobox', { name: 'Адрес объекта' })).not.toHaveTextContent(
      'ул. Первая',
    );
    await user.click(screen.getByRole('button', { name: 'Очистить: Объект' }));
    expect(screen.getByTestId('object-id')).toHaveTextContent('');
    expect(screen.getByRole('combobox', { name: 'Объект' })).toHaveTextContent('Поиск по названию');
    expect(screen.getByRole('combobox', { name: 'Адрес объекта' })).toHaveTextContent(
      'Поиск по адресу',
    );
  });

  it('does not offer archived objects and keeps duplicate names distinct by id', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('combobox', { name: 'Объект' }));
    expect(screen.getAllByRole('option', { name: /ул\. Первая, 1/ })).toHaveLength(2);
    expect(screen.getByRole('option', { name: /ул\. Вторая, 2/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Архив/ })).toBeNull();
    await user.click(screen.getByRole('option', { name: /Альфа.*Первая/ }));
    expect(screen.getByTestId('object-id')).toHaveTextContent('obj-a');
  });
});
