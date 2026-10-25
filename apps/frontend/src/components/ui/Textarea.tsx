import type { TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'min-h-control w-full rounded-md border border-border bg-background px-3 py-2 text-base text-foreground aria-invalid:border-destructive disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}
