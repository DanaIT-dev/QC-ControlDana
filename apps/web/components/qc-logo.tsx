import Link from 'next/link';
import { cn } from '@/lib/utils';

const SIZES = {
  header: { className: 'h-8 w-[47px]', width: 47, height: 32 },
  sheet: { className: 'h-7 w-[41px]', width: 41, height: 28 },
  login: { className: 'h-10 w-[59px]', width: 59, height: 40 },
} as const;

function QcMark({
  className,
  width,
  height,
}: {
  className?: string;
  width: number;
  height: number;
}) {
  return (
    <svg
      viewBox="0 0 88 60"
      width={width}
      height={height}
      className={cn('overflow-visible', className)}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M71.31 14.24 A 20 20 0 1 1 71.31 45.76"
        fill="none"
        stroke="var(--brand-c)"
        strokeWidth="10"
        strokeLinecap="butt"
      />
      <circle cx="30" cy="30" r="20" fill="none" stroke="var(--brand-q)" strokeWidth="10" />
      <line
        x1="38.17"
        y1="37.36"
        x2="52.29"
        y2="50.07"
        stroke="var(--brand-c)"
        strokeWidth="10"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function QcLogo({
  href,
  size = 'header',
  decorative = false,
  className,
}: {
  href?: string;
  size?: keyof typeof SIZES;
  decorative?: boolean;
  className?: string;
}) {
  const dim = SIZES[size];
  const mark = (
    <QcMark className={cn(dim.className, className)} width={dim.width} height={dim.height} />
  );

  if (href) {
    return (
      <Link
        href={href}
        aria-label="QC.Dana"
        className="inline-flex w-fit shrink-0 items-center rounded-sm"
      >
        {mark}
      </Link>
    );
  }

  if (decorative) {
    return mark;
  }

  return (
    <span
      className="inline-flex w-fit shrink-0 items-center self-start"
      role="img"
      aria-label="QC.Dana"
    >
      {mark}
    </span>
  );
}
