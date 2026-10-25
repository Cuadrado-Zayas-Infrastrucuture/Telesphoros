import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const alertVariants = cva('rounded-md border p-4 text-sm', {
  variants: {
    variant: {
      info: 'border-primary bg-surface text-foreground',
      success: 'border-success bg-success-surface text-success',
      warning: 'border-warning bg-warning-surface text-warning',
      destructive: 'border-destructive bg-destructive-surface text-destructive',
    },
  },
  defaultVariants: { variant: 'info' },
});

export interface AlertProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {}

/**
 * Errors use role="alert" (announced immediately); everything else role="status"
 * (announced politely) so screen-reader users hear outcomes without losing their place.
 */
export function Alert({ className, variant, ...props }: AlertProps) {
  return <div role={variant === 'destructive' ? 'alert' : 'status'} className={cn(alertVariants({ variant }), className)} {...props} />;
}
