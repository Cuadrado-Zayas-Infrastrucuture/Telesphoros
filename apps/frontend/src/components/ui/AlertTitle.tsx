import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function AlertTitle({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('mb-1 font-semibold', className)} {...props} />;
}
