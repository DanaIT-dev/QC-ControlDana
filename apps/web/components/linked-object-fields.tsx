'use client';

import {
  propertyObjectById,
  selectablePropertyObjects,
  type PropertyObjectChoice,
  type PropertyObjectSearchField,
} from '@sgr-registry/domain';
import { XIcon } from 'lucide-react';
import { useMemo } from 'react';
import { DirectoryCombobox } from '@/components/directory-combobox';
import { Button } from '@/components/ui/button';

export function LinkedObjectFields({
  objects,
  objectId,
  onObjectIdChange,
  canCreate,
  onAdd,
}: {
  objects: PropertyObjectChoice[];
  objectId: string;
  onObjectIdChange: (next: string) => void;
  canCreate?: boolean;
  onAdd?: (input: { query: string; field: PropertyObjectSearchField }) => void;
}) {
  const selected = propertyObjectById(objects, objectId);

  return (
    <div className="grid min-w-0 gap-4 md:col-span-2 md:grid-cols-2">
      <ObjectSearchCombobox
        label="Объект"
        field="name"
        objects={objects}
        selected={selected}
        onSelect={onObjectIdChange}
        canCreate={canCreate}
        onAdd={onAdd}
      />
      <ObjectSearchCombobox
        label="Адрес объекта"
        field="address"
        objects={objects}
        selected={selected}
        onSelect={onObjectIdChange}
        canCreate={canCreate}
        onAdd={onAdd}
      />
    </div>
  );
}

function ObjectSearchCombobox({
  label,
  field,
  objects,
  selected,
  onSelect,
  canCreate,
  onAdd,
}: {
  label: string;
  field: PropertyObjectSearchField;
  objects: PropertyObjectChoice[];
  selected: PropertyObjectChoice | null;
  onSelect: (next: string) => void;
  canCreate?: boolean;
  onAdd?: (input: { query: string; field: PropertyObjectSearchField }) => void;
}) {
  const options = useMemo(() => {
    const visible = selectablePropertyObjects(objects);
    const rows =
      selected && !visible.some((item) => item.id === selected.id)
        ? [...visible, selected]
        : visible;
    return rows.map((item) => ({
      id: item.id,
      label: field === 'name' ? item.name : item.address,
      secondary: field === 'name' ? item.address : item.name,
    }));
  }, [objects, selected, field]);
  const placeholder = field === 'name' ? 'Поиск по названию' : 'Поиск по адресу';

  return (
    <div className="flex min-w-0 items-end gap-1">
      <div className="min-w-0 flex-1">
        <DirectoryCombobox
          label={label}
          placeholder={placeholder}
          options={options}
          value={selected?.id ?? ''}
          onChange={onSelect}
          emptyText="Нет объектов"
          addLabel={canCreate ? 'Добавить объект' : undefined}
          onAdd={canCreate && onAdd ? (next) => onAdd({ query: next, field }) : undefined}
        />
      </div>
      {selected ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-11 min-h-11 w-11 shrink-0"
          aria-label={`Очистить: ${label}`}
          onClick={() => onSelect('')}
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}
