const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DISPLAY_DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

export function formatDisplayDate(iso: string): string {
  const match = ISO_DATE.exec(iso);
  if (!match) {
    return '';
  }
  return `${match[3]}.${match[2]}.${match[1]}`;
}

export function maskDateInput(raw: string): string {
  const iso = ISO_DATE.exec(raw.trim());
  if (iso) {
    return `${iso[3]}.${iso[2]}.${iso[1]}`;
  }
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) {
    return digits;
  }
  if (digits.length <= 4) {
    return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  }
  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
}

export function parseDisplayDate(text: string): { ok: true; value: string } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: true, value: '' };
  }
  const dotted = DISPLAY_DATE.exec(trimmed);
  const iso = ISO_DATE.exec(trimmed);
  if (!dotted && !iso) {
    return { ok: false };
  }
  const year = Number((dotted?.[3] ?? iso?.[1]) || 0);
  const month = Number((dotted?.[2] ?? iso?.[2]) || 0);
  const day = Number((dotted?.[1] ?? iso?.[3]) || 0);
  if (!isRealCalendarDate(year, month, day)) {
    return { ok: false };
  }
  return {
    ok: true,
    value: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

export function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (!year || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
  );
}

export function todayIso(timeZone = 'Europe/Minsk'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

export function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const utc = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1 };
}

export function monthGrid(year: number, month: number): Array<Array<string | null>> {
  const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: Array<string | null> = [];
  for (let index = 0; index < firstWeekday; index += 1) {
    cells.push(null);
  }
  for (let day = 1; day <= days; day += 1) {
    cells.push(
      `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    );
  }
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }
  const rows: Array<Array<string | null>> = [];
  for (let index = 0; index < cells.length; index += 7) {
    rows.push(cells.slice(index, index + 7));
  }
  return rows;
}

export function monthLabel(year: number, month: number): string {
  const label = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
  const cleaned = label.replace(/\s*г\.?$/u, '');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
