// Adapted from Prompt Kit; see README.md and LICENSE.md.
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
export function Message({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex min-w-0 gap-3', className)} {...props} />;
}
