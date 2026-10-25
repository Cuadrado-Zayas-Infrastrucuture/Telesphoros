// Adapted from Prompt Kit; preserve the shared button and avoid decorative pills.
import type { ButtonHTMLAttributes } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
export function PromptSuggestion({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button {...props} variant="outline" size="sm" className="h-auto min-h-control min-w-0 justify-between gap-3 whitespace-normal text-left text-sm">
      <span>{children}</span>
      <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
    </Button>
  );
}
