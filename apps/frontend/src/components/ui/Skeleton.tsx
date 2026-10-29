// Adapted from shadcn/ui Skeleton (base), https://github.com/shadcn-ui/ui at 96da9cc (MIT): the approved divider tone, a delayed sweep (`.skeleton`, index.css).
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Decorative loading placeholder, hidden from assistive technology: put one `role="status"` text beside it that says what is loading. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" data-slot="skeleton" className={cn('skeleton rounded-sm', className)} {...props} />;
}
