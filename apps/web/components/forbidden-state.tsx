import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function ForbiddenState({
  title = 'Недостаточно прав',
  description,
  homeHref = '/registry',
  homeLabel = 'Вернуться в реестр',
}: {
  title?: string;
  description: string;
  homeHref?: string;
  homeLabel?: string;
}) {
  return (
    <Card className="max-w-lg shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <AlertTriangle className="size-5 text-warning-foreground" aria-hidden />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline">
          <Link href={homeHref}>{homeLabel}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
