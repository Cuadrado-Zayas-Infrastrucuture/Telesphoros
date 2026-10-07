import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

export function Input({ className, type = 'text', ...props }: InputProps) {
  return (
    <input
      type={type}
      className={cn(
        'h-control w-full rounded-md border border-border bg-background px-3 text-base text-foreground',
        'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60',
        'aria-invalid:border-destructive',
        // File inputs: keep the native control but make the button part readable and tappable.
        'file:mr-3 file:rounded-sm file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground',
        type === 'file' && 'py-1.5',
        className,
      )}
      {...props}
    />
  );
}
