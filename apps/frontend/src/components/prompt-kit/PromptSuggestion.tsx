// Adapted from Prompt Kit; preserve the shared button and avoid decorative pills.
import type { ButtonHTMLAttributes } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
// A caller's className is merged in (specs/023 keeps short workspace chips on one line); before, it was silently dropped.
export function PromptSuggestion({ children, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button {...props} variant="outline" size="sm" className={cn('h-auto min-h-control min-w-0 justify-between gap-3 whitespace-normal text-left text-sm', className)}>
      <span>{children}</span>
      <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
    </Button>
  );
}
