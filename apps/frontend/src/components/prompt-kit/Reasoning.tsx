// Adapted from Prompt Kit Reasoning using native disclosure. Never displays private chain of thought.
import type { ReactNode } from 'react';
export function Reasoning({ children }: { children: ReactNode }) {
  return <details className="border-t border-divider"><summary className="min-h-control cursor-pointer py-3 text-sm font-semibold">Explanation basis</summary><div className="pb-3 text-sm leading-relaxed text-muted-foreground">{children}</div></details>;
}
