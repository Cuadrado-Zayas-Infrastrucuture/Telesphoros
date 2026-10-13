// Adapted from Prompt Kit; see README.md and LICENSE.md.
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
export function MessageContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-w-0 rounded-lg bg-muted p-4 text-sm leading-relaxed text-foreground wrap-anywhere whitespace-pre-wrap', className)} {...props} />;
}
