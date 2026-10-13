// Adapted from Prompt Kit; all semantic colors come from project tokens.
import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
export function SystemMessage({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div role={error ? 'alert' : undefined} className={`flex items-start gap-3 rounded-md px-4 py-3 text-sm ${error ? 'bg-destructive-surface text-destructive' : 'bg-muted text-foreground'}`}><Info aria-hidden="true" className="mt-1 size-4 shrink-0" /><div className="min-w-0">{children}</div></div>;
}
