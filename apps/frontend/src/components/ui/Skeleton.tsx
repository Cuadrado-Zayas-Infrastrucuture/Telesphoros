// Adapted from shadcn/ui Skeleton (base), https://github.com/shadcn-ui/ui at 96da9cc (MIT): the approved divider tone, motion-safe pulse.
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Decorative loading placeholder. Say what is loading in visible or status text beside it. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" data-slot="skeleton" className={cn('rounded-sm bg-divider motion-safe:animate-pulse', className)} {...props} />;
}
