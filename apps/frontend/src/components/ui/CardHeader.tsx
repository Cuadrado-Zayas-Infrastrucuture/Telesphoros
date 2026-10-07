import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 p-5', className)} {...props} />;
}
