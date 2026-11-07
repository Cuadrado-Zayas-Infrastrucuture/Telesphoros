import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, Ref } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex min-w-control items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-colors duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
  {
    variants: {
      variant: {
        default: 'button-raised border border-primary bg-primary text-primary-foreground not-disabled:not-aria-disabled:hover:bg-primary-hover',
        outline: 'border border-border bg-panel text-foreground not-disabled:not-aria-disabled:hover:bg-muted',
        ghost: 'text-foreground not-disabled:not-aria-disabled:hover:bg-muted',
        destructive: 'button-raised border border-destructive bg-destructive text-destructive-foreground not-disabled:not-aria-disabled:hover:opacity-90',
      },
      size: {
        sm: 'h-button-sm px-3 text-sm',
        md: 'h-button-md px-4 text-sm',
        lg: 'h-button-lg px-6 text-lg',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

interface ButtonBaseProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  ref?: Ref<HTMLButtonElement>;
}

/** Pending is for actions; link composition keeps its child's content and behavior. */
export type ButtonProps = ButtonBaseProps & ({ asChild: true; pending?: never; pendingLabel?: never } | { asChild?: false; pending?: boolean; pendingLabel?: string });

export function Button({ className, variant, size, asChild = false, type, pending, pendingLabel, disabled, children, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild)
    return (
      <Slot className={classes} {...{ disabled }} {...props}>
        {children}
      </Slot>
    );
  const progressLabel = pendingLabel ?? 'Working…';
  return (
    <>
      <button {...props} type={type ?? 'button'} className={classes} disabled={disabled || pending} aria-busy={pending || undefined}>
        {pendingLabel !== undefined || pending !== undefined ? (
          <span className="grid">
            <span aria-hidden={pending} className={cn('col-start-1 row-start-1 inline-flex items-center justify-center gap-2', pending && 'invisible')}>
              {children}
            </span>
            <span aria-hidden={!pending} className={cn('col-start-1 row-start-1 inline-flex items-center justify-center gap-2', !pending && 'invisible')}>
              <Spinner className="motion-reduce:animate-none" />
              {progressLabel}
            </span>
          </span>
        ) : (
          children
        )}
      </button>
      {(pendingLabel !== undefined || pending !== undefined) && (
        <span role="status" className="sr-only">
          {pending ? progressLabel : ''}
        </span>
      )}
    </>
  );
}
