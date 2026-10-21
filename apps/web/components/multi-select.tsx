'use client';

import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
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
import { controlTriggerClasses, controlTriggerIconClasses } from '@/lib/control-styles';
import { cn } from '@/lib/utils';

export interface MultiSelectOption {
  id: string;
  label: string;
  title?: string;
}

export function MultiSelect({
  label,
  placeholder = 'Выберите',
  options,
  values,
  onChange,
  disabled,
  emptyText = 'Нет значений',
  hideLabel = false,
}: {
  label: string;
  placeholder?: string;
  options: MultiSelectOption[];
  values: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  emptyText?: string;
  hideLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => options.filter((option) => values.includes(option.id)),
    [options, values],
  );

  function toggle(id: string) {
    onChange(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  }

  const allSelected = options.length > 0 && options.every((option) => values.includes(option.id));

  const summary =
    selected.length === 0 ? (
      <span className="truncate text-muted-foreground">{placeholder}</span>
    ) : selected.length === 1 ? (
      <span className="truncate whitespace-nowrap" title={selected[0]?.title ?? selected[0]?.label}>
        {selected[0]?.label}
      </span>
    ) : (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate">{selected[0]?.label}</span>
        <Badge variant="secondary">+{selected.length - 1}</Badge>
      </span>
    );

  return (
    <div className={hideLabel ? 'min-w-0' : 'grid gap-1.5'}>
      {hideLabel ? null : <span className="text-[13px] font-medium text-foreground">{label}</span>}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={label}
            disabled={disabled}
            className={cn(
              'h-11 min-h-11 w-full justify-between font-normal',
              controlTriggerClasses,
            )}
          >
            <span className="flex min-w-0 flex-1 items-center text-left">{summary}</span>
            <ChevronsUpDownIcon className={controlTriggerIconClasses} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          <div className="flex gap-2 border-b p-2">
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 flex-1"
              disabled={options.length === 0 || allSelected}
              aria-label={`Выбрать все: ${label}`}
              onClick={() => onChange(options.map((option) => option.id))}
            >
              Выбрать все
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 flex-1"
              disabled={values.length === 0}
              aria-label={`Сбросить: ${label}`}
              onClick={() => onChange([])}
            >
              Сбросить
            </Button>
          </div>
          <Command>
            <CommandInput placeholder="Поиск…" aria-label={`Поиск: ${label}`} />
            <CommandList className="max-h-60">
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {options.map((option) => {
                  const checked = values.includes(option.id);
                  return (
                    <CommandItem
                      key={option.id}
                      value={`${option.label} ${option.title ?? ''} ${option.id}`}
                      data-checked={checked}
                      role="option"
                      aria-selected={checked}
                      aria-label={option.title ?? option.label}
                      title={option.title ?? option.label}
                      className="flex h-9 min-h-9 flex-row items-center justify-start gap-2 px-2 [&>svg:last-child]:hidden"
                      onSelect={() => toggle(option.id)}
                    >
                      <span
                        data-slot="option-check"
                        className={cn(
                          'flex size-4 max-h-[18px] max-w-[18px] shrink-0 items-center justify-center rounded-[4px] border',
                          checked
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-input bg-white',
                        )}
                      >
                        {checked ? <CheckIcon className="size-3.5" /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">
                        {option.label}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
