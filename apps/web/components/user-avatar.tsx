import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { initials } from '@/lib/initials';
import { cn } from '@/lib/utils';

export function UserAvatar({
  name,
  size = 'default',
  className,
}: {
  name: string;
  size?: 'default' | 'sm' | 'lg';
  className?: string;
}) {
  return (
    <Avatar size={size} className={cn('bg-accent text-accent-foreground', className)}>
      <AvatarFallback className="bg-accent text-[11px] font-medium text-accent-foreground">
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
