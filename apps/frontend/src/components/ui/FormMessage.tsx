import type { HTMLAttributes } from 'react';
import { useFormField } from '@/hooks/useFormField';
import { cn } from '@/lib/utils';

export function FormMessage({ className, children, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  const { error, messageId } = useFormField();
  const body = error ? String(error.message ?? '') : children;
  if (!body) return null;
  return (
    <p id={messageId} className={cn('text-sm font-medium text-destructive', className)} {...props}>
      {body}
    </p>
  );
}
