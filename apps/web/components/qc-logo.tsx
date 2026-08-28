import Link from 'next/link';
import { cn } from '@/lib/utils';

const SIZES = {
  header: { className: 'h-8 w-[90px]', width: 90, height: 32 },
  sheet: { className: 'h-7 w-[78px]', width: 78, height: 28 },
  login: { className: 'h-10 w-[112px]', width: 112, height: 40 },
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
    <img
      src="/qc-logo.svg"
      alt=""
      width={width}
      height={height}
      className={cn('object-contain object-left', className)}
      aria-hidden="true"
    />
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
