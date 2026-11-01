import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-pretty text-muted-foreground', className)} {...props} />;
}
