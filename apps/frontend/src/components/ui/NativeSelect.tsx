import type { SelectHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/utils';

export interface NativeSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  ref?: Ref<HTMLSelectElement>;
}

/** The platform <select>: free keyboard support, native mobile pickers, zero JavaScript. */
export function NativeSelect({ className, ...props }: NativeSelectProps) {
  return (
    <select
      className={cn(
        'h-control w-full rounded-md border border-border bg-background px-3 text-base text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
