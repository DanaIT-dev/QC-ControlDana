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
import { cn } from '@/lib/utils';

export interface MultiSelectOption {
  id: string;
  label: string;
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

  const summary =
    selected.length === 0 ? (
      <span className="truncate text-muted-foreground">{placeholder}</span>
    ) : selected.length === 1 ? (
      <span className="truncate">{selected[0]?.label}</span>
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
            className="h-11 min-h-11 w-full justify-between px-3 font-normal"
          >
            <span className="flex min-w-0 flex-1 items-center text-left">{summary}</span>
            <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
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
                      value={`${option.label} ${option.id}`}
                      data-checked={checked}
                      role="option"
                      aria-selected={checked}
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
                      <span className="min-w-0 flex-1 text-left">{option.label}</span>
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
