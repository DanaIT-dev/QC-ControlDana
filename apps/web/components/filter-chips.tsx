'use client';

import { XIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { FilterChip } from '@/lib/filter-chips';

export function FilterChips({
  chips,
  onRemove,
}: {
  chips: FilterChip[];
  onRemove: (chip: FilterChip) => void;
}) {
  if (chips.length === 0) {
    return null;
  }
  return (
    <div
      className="flex gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible"
      data-slot="filter-chips"
    >
      {chips.map((chip) => (
        <Badge
          key={chip.id}
          variant="secondary"
          className="h-7 max-w-full shrink-0 gap-1 px-2 text-[12px]"
        >
          <span className="truncate">{chip.label}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-6 min-h-6 min-w-6"
            aria-label={`Удалить фильтр ${chip.label}`}
            onClick={() => onRemove(chip)}
          >
            <XIcon className="size-3.5" />
          </Button>
        </Badge>
      ))}
    </div>
  );
}
