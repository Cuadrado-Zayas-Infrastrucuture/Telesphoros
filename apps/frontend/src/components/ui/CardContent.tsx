import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}
