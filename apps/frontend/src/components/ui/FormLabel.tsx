import type { ComponentProps } from 'react';
import { Label } from '@/components/ui/Label';
import { useFormField } from '@/hooks/useFormField';
import { cn } from '@/lib/utils';

export function FormLabel({
  className,
  ...props
}: ComponentProps<typeof Label>) {
  const { inputId, error } = useFormField();
  return (
    <Label
      htmlFor={inputId}
      className={cn(error && 'text-destructive', className)}
      {...props}
    />
  );
}
