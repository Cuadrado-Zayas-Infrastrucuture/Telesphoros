import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Decorative: always sits next to visible text that states what is loading. */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden="true" className={cn('size-4 animate-spin', className)} />;
}
