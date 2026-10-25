import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Pass the heading level that fits the page outline via `as`. */
export function CardTitle({ as: Tag = 'h2', className, ...props }: HTMLAttributes<HTMLHeadingElement> & { as?: 'h2' | 'h3' | 'h4' }) {
  return <Tag className={cn('text-lg leading-tight font-semibold', className)} {...props} />;
}
