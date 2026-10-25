import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, Ref } from 'react';
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

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  ref?: Ref<HTMLButtonElement>;
  /** Render the child element (e.g. a router link) with button styling. */
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      // Default to type="button" so a stray button never submits a form by accident.
      {...(asChild ? {} : { type: type ?? 'button' })}
      {...props}
    />
  );
}
