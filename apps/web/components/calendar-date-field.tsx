'use client';

import { CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  formatDisplayDate,
  maskDateInput,
  monthGrid,
  monthLabel,
  parseDisplayDate,
  shiftMonth,
  todayIso,
} from '@/lib/calendar-date';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;

export function CalendarDateField({
  id,
  label,
  value,
  onChange,
  onInvalidChange,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onInvalidChange?: (invalid: boolean) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(() => formatDisplayDate(value));
  const [committed, setCommitted] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const initial = value || todayIso();
  const [cursor, setCursor] = useState(() => monthCursor(initial));
  if (value !== committed && !invalid) {
    setCommitted(value);
    setText(formatDisplayDate(value));
    setCursor(monthCursor(value || todayIso()));
  }

  function reportInvalid(next: boolean) {
    setInvalid(next);
    onInvalidChange?.(next);
  }

  function commit(nextText: string) {
    const parsed = parseDisplayDate(nextText);
    if (!parsed.ok) {
      setText(nextText);
      reportInvalid(true);
      return;
    }
    setText(parsed.value ? formatDisplayDate(parsed.value) : '');
    setCommitted(parsed.value);
    reportInvalid(false);
    if (parsed.value !== value) {
      onChange(parsed.value);
    }
    if (parsed.value) {
      setCursor(monthCursor(parsed.value));
    }
  }

  const rows = monthGrid(cursor.year, cursor.month);
  const today = todayIso();

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          value={text}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="ДД.ММ.ГГГГ"
          aria-invalid={invalid || undefined}
          disabled={disabled}
          maxLength={10}
          className="pr-12"
          onChange={(event) => {
            const next = maskDateInput(event.target.value);
            setText(next);
            if (invalid) {
              reportInvalid(false);
            }
          }}
          onBlur={() => commit(text)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit(text);
            }
          }}
        />
        <Popover
          open={open}
          onOpenChange={(next) => {
            if (next) {
              setCursor(monthCursor(value || todayIso()));
            }
            setOpen(next);
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute top-0 right-0"
              disabled={disabled}
              aria-label={`Календарь: ${label}`}
            >
              <CalendarIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            data-calendar-popover=""
            align="end"
            className="z-[80] w-auto p-3"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Предыдущий месяц"
                onClick={() => setCursor((current) => shiftMonth(current.year, current.month, -1))}
              >
                <ChevronLeft />
              </Button>
              <p className="text-sm font-medium">{monthLabel(cursor.year, cursor.month)}</p>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Следующий месяц"
                onClick={() => setCursor((current) => shiftMonth(current.year, current.month, 1))}
              >
                <ChevronRight />
              </Button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center text-[12px] text-muted-foreground">
              {WEEKDAYS.map((day) => (
                <span key={day} className="py-1">
                  {day}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {rows.flat().map((iso, index) =>
                iso ? (
                  <button
                    key={iso}
                    type="button"
                    className={cn(
                      'h-9 rounded-md text-sm text-foreground hover:bg-muted',
                      iso === value && 'bg-primary text-primary-foreground hover:bg-primary-hover',
                      iso === today && iso !== value && 'ring-1 ring-ring',
                    )}
                    onClick={() => {
                      commit(formatDisplayDate(iso));
                      setOpen(false);
                    }}
                  >
                    {Number(iso.slice(-2))}
                  </button>
                ) : (
                  <span key={`empty-${index}`} />
                ),
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 w-full"
              onClick={() => {
                commit('');
                setOpen(false);
              }}
            >
              Очистить
            </Button>
          </PopoverContent>
        </Popover>
      </div>
      {invalid ? (
        <p className="text-sm text-destructive" role="alert">
          Некорректная дата. Укажите её в формате ДД.ММ.ГГГГ.
        </p>
      ) : null}
    </div>
  );
}

function monthCursor(iso: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    const today = todayIso();
    return {
      year: Number(today.slice(0, 4)),
      month: Number(today.slice(5, 7)),
    };
  }
  return { year: Number(match[1]), month: Number(match[2]) };
}
