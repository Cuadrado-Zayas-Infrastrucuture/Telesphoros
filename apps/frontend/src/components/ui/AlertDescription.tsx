import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function AlertDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-foreground', className)} {...props} />;
}
