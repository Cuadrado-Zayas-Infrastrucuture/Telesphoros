import type { HTMLAttributes } from 'react';
import { useFormField } from '@/hooks/useFormField';
import { cn } from '@/lib/utils';

export function FormDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  const { descriptionId } = useFormField();
  return <p id={descriptionId} className={cn('text-sm text-muted-foreground', className)} {...props} />;
}
