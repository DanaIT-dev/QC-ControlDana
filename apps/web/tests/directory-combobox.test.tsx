import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectoryCombobox } from '../components/directory-combobox';

const ENGINEERS = Array.from({ length: 40 }, (_, index) => ({
  id: `eng-${index}`,
  label: `Инженер ${index} Иванович`,
}));

function Harness({ addLabel, onAdd }: { addLabel?: string; onAdd?: (query: string) => void }) {
  const [value, setValue] = useState('');
  const [values, setValues] = useState<string[]>([]);
  return (
    <div>
      <DirectoryCombobox
        label="Ответственные инженеры"
        options={ENGINEERS}
        values={values}
        onValuesChange={setValues}
        addLabel={addLabel}
        onAdd={onAdd}
      />
      <DirectoryCombobox
        label="Вид работ"
        options={[{ id: 'w1', label: 'Окна' }]}
        value={value}
        onChange={setValue}
        addLabel={addLabel}
        onAdd={onAdd}
      />
    </div>
  );
}

afterEach(() => {
  cleanup();
});

describe('DirectoryCombobox', () => {
  it('shows a sticky add command, empty-state create and never renders email', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const { container } = render(<Harness addLabel="Добавить вид работ" onAdd={onAdd} />);
    await user.click(screen.getByRole('combobox', { name: 'Вид работ' }));
    expect(screen.getByRole('button', { name: '+ Добавить вид работ' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Поиск: Вид работ'), 'Новый вид');
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: '+ Добавить «Новый вид»' })[0]!);
    expect(onAdd).toHaveBeenCalledWith('Новый вид');
    expect(container.innerHTML).not.toMatch(/@/);
  });

  it('keeps option list scrollable and displays FIO only', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('combobox', { name: 'Ответственные инженеры' }));
    const list = document.querySelector('[data-slot="command-list"]');
    expect(list).toBeTruthy();
    expect((list as HTMLElement).className).toMatch(/overflow-y-auto/);
    expect(screen.getByRole('option', { name: /Инженер 0 Иванович/ })).toBeInTheDocument();
    expect(screen.queryByText(/@/)).toBeNull();
    await user.click(screen.getByRole('option', { name: /Инженер 3 Иванович/ }));
    expect(screen.getByRole('combobox', { name: 'Ответственные инженеры' })).toHaveTextContent(
      'Инженер 3 Иванович',
    );
  });
});
