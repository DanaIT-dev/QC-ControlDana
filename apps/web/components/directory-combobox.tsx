'use client';

import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from 'lucide-react';
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

export interface DirectoryOption {
  id: string;
  label: string;
  secondary?: string;
  title?: string;
}

export function DirectoryCombobox({
  label,
  placeholder = 'Выберите',
  searchPlaceholder = 'Поиск…',
  options,
  value,
  values,
  onChange,
  onValuesChange,
  disabled,
  emptyText = 'Нет значений',
  loading = false,
  errorText,
  addLabel,
  onAdd,
  noneOption,
  hideLabel = false,
}: {
  label: string;
  placeholder?: string;
  searchPlaceholder?: string;
  options: DirectoryOption[];
  value?: string;
  values?: string[];
  onChange?: (next: string) => void;
  onValuesChange?: (next: string[]) => void;
  disabled?: boolean;
  emptyText?: string;
  loading?: boolean;
  errorText?: string;
  addLabel?: string;
  onAdd?: (query: string) => void;
  noneOption?: DirectoryOption;
  hideLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const multiple = Boolean(onValuesChange);
  const selectedIds = multiple ? (values ?? []) : value ? [value] : [];
  const selected = useMemo(
    () => options.filter((option) => selectedIds.includes(option.id)),
    [options, selectedIds],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ru');
    const base =
      noneOption && (!needle || noneOption.label.toLocaleLowerCase('ru').includes(needle))
        ? [noneOption, ...options]
        : options;
    if (!needle) {
      return base;
    }
    return base.filter((option) => {
      const haystack =
        `${option.label} ${option.title ?? ''} ${option.secondary ?? ''}`.toLocaleLowerCase('ru');
      return haystack.includes(needle);
    });
  }, [noneOption, options, query]);

  function close() {
    setOpen(false);
    setQuery('');
  }

  function select(id: string) {
    if (multiple) {
      const current = values ?? [];
      onValuesChange?.(
        current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
      );
      return;
    }
    onChange?.(id === noneOption?.id ? '' : id);
    close();
  }

  const summary = multiple
    ? selected.length === 0
      ? placeholder
      : selected.length === 1
        ? selected[0]?.label
        : undefined
    : (selected[0]?.label ??
      (value && noneOption && value === noneOption.id ? noneOption.label : undefined));

  return (
    <div className={hideLabel ? 'min-w-0' : 'grid min-w-0 gap-1.5'}>
      {hideLabel ? null : <span className="text-[13px] font-medium text-foreground">{label}</span>}
      <Popover
        modal={false}
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
            disabled={disabled}
            className={cn(
              'h-11 min-h-11 w-full justify-between font-normal',
              controlTriggerClasses,
            )}
          >
            <span className="flex min-w-0 flex-1 items-center text-left">
              {multiple && selected.length > 1 ? (
                <span className="flex min-w-0 items-center gap-1">
                  <span className="truncate">{selected[0]?.label}</span>
                  <Badge variant="secondary">+{selected.length - 1}</Badge>
                </span>
              ) : summary ? (
                <span className="truncate">{summary}</span>
              ) : (
                <span className="truncate text-muted-foreground">{placeholder}</span>
              )}
            </span>
            <ChevronsUpDownIcon className={controlTriggerIconClasses} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={16}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
          onTouchMove={(event) => event.stopPropagation()}
          className="flex w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] max-h-[min(24rem,var(--radix-popover-content-available-height,70vh))] flex-col overflow-hidden p-0"
        >
          <Command
            shouldFilter={false}
            className="flex max-h-full min-h-0 flex-col overflow-hidden"
          >
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={searchPlaceholder}
              aria-label={`Поиск: ${label}`}
            />
            <CommandList className="min-h-0 max-h-[min(16rem,calc(var(--radix-popover-content-available-height,70vh)-8rem))] max-block-[min(16rem,calc(var(--radix-popover-content-available-height,70vh)-8rem))] overflow-y-auto overscroll-contain">
              {loading ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">Загрузка…</p>
              ) : errorText ? (
                <p className="px-3 py-6 text-center text-sm text-error-foreground">{errorText}</p>
              ) : (
                <>
                  <CommandEmpty>
                    <span className="block py-2">
                      {query.trim() ? 'Ничего не найдено' : emptyText}
                    </span>
                    {onAdd && addLabel && query.trim() ? (
                      <button
                        type="button"
                        className="mx-auto mb-2 flex min-h-9 items-center gap-1 rounded-md px-2 text-sm text-primary hover:bg-muted"
                        onClick={() => {
                          const next = query.trim();
                          close();
                          onAdd(next);
                        }}
                      >
                        {`+ Добавить «${query.trim()}»`}
                      </button>
                    ) : null}
                  </CommandEmpty>
                  {filtered.length > 0 ? (
                    <CommandGroup>
                      {filtered.map((option) => {
                        const checked = selectedIds.includes(option.id);
                        return (
                          <CommandItem
                            key={option.id}
                            value={option.id}
                            role="option"
                            aria-selected={checked}
                            aria-label={
                              option.title ??
                              [option.label, option.secondary].filter(Boolean).join(' ')
                            }
                            title={option.title ?? option.label}
                            data-checked={checked}
                            className={cn(
                              'flex min-h-9 flex-row items-start justify-start gap-2 px-2 [&>svg:last-child]:hidden',
                              option.secondary ? 'h-auto py-2' : 'h-9',
                            )}
                            onSelect={() => select(option.id)}
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
                            <span className="flex min-w-0 flex-1 flex-col items-start text-left">
                              <span className="w-full truncate whitespace-nowrap">
                                {option.label}
                              </span>
                              {option.secondary ? (
                                <span className="w-full truncate text-xs text-muted-foreground">
                                  {option.secondary}
                                </span>
                              ) : null}
                            </span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ) : null}
                </>
              )}
            </CommandList>
            {onAdd && addLabel ? (
              <div className="sticky bottom-0 z-10 shrink-0 border-t bg-popover">
                <button
                  type="button"
                  data-slot="directory-add"
                  className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-medium text-primary hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  onClick={() => {
                    const next = query.trim();
                    close();
                    onAdd(next);
                  }}
                >
                  <PlusIcon className="size-4 shrink-0" />
                  {addLabel.startsWith('+') ? addLabel : `+ ${addLabel}`}
                </button>
              </div>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
