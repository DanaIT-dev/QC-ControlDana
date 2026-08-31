'use client';

import {
  filterPropertyObjects,
  propertyObjectById,
  type PropertyObjectChoice,
  type PropertyObjectSearchField,
} from '@sgr-registry/domain';
import { CheckIcon, ChevronsUpDownIcon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export function LinkedObjectFields({
  objects,
  objectId,
  onObjectIdChange,
}: {
  objects: PropertyObjectChoice[];
  objectId: string;
  onObjectIdChange: (next: string) => void;
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
      />
      <ObjectSearchCombobox
        label="Адрес объекта"
        field="address"
        objects={objects}
        selected={selected}
        onSelect={onObjectIdChange}
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
}: {
  label: string;
  field: PropertyObjectSearchField;
  objects: PropertyObjectChoice[];
  selected: PropertyObjectChoice | null;
  onSelect: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const options = useMemo(
    () => filterPropertyObjects(objects, query, field),
    [objects, query, field],
  );
  const primary = field === 'name' ? selected?.name : selected?.address;
  const placeholder = field === 'name' ? 'Поиск по названию' : 'Поиск по адресу';

  function close() {
    setOpen(false);
    setQuery('');
  }

  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1">
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) {
              setQuery('');
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-haspopup="listbox"
              aria-label={label}
              className="h-11 min-h-11 min-w-0 flex-1 justify-between px-3 font-normal"
            >
              <span className="flex min-w-0 flex-1 items-center text-left">
                {primary ? (
                  <span className="truncate">{primary}</span>
                ) : (
                  <span className="truncate text-muted-foreground">{placeholder}</span>
                )}
              </span>
              <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            collisionPadding={16}
            className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0"
          >
            <Command shouldFilter={false}>
              <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder="Поиск…"
                aria-label={`Поиск: ${label}`}
              />
              <CommandList className="max-h-60">
                <CommandEmpty>Нет объектов</CommandEmpty>
                <CommandGroup>
                  {options.map((item) => {
                    const checked = selected?.id === item.id;
                    const heading = field === 'name' ? item.name : item.address;
                    const secondary = field === 'name' ? item.address : item.name;
                    return (
                      <CommandItem
                        key={item.id}
                        value={item.id}
                        role="option"
                        aria-selected={checked}
                        data-checked={checked}
                        className="flex h-auto min-h-11 items-start justify-start gap-2 py-2 [&>svg:last-child]:hidden"
                        onSelect={() => {
                          onSelect(item.id);
                          close();
                        }}
                      >
                        <span
                          className={cn(
                            'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                            checked
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-input bg-white',
                          )}
                        >
                          {checked ? <CheckIcon className="size-3.5" /> : null}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
                          <span className="w-full truncate">{heading}</span>
                          <span className="w-full truncate text-xs text-muted-foreground">
                            {secondary}
                          </span>
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
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
    </div>
  );
}
