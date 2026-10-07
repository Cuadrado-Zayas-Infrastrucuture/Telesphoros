import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/utils';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  ref?: Ref<HTMLInputElement>;
}

/** Native checkbox with a 24px hit area; pair it with a <Label htmlFor> for the full row target. */
export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <input
      type="checkbox"
      className={cn('size-6 shrink-0 accent-primary aria-invalid:outline-destructive', className)}
      {...props}
    />
  );
}
