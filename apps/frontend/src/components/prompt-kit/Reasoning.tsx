// Adapted from Prompt Kit Reasoning using native disclosure. Never displays private chain of thought.
import type { ReactNode } from 'react';
import { ChevronDown, ListTree } from 'lucide-react';
export function Reasoning({ children }: { children: ReactNode }) {
  return <details className="preview-reasoning border-t border-divider"><summary className="flex min-h-control cursor-pointer items-center gap-2 py-3 text-sm font-medium"><ListTree aria-hidden="true" className="size-4 shrink-0" /><span>Explanation basis</span><ChevronDown aria-hidden="true" className="preview-disclosure-chevron ml-auto size-4 shrink-0" /></summary><div className="border-l border-divider pb-3 pl-4 text-sm leading-relaxed text-muted-foreground">{children}</div></details>;
}
